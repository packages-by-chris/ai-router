"""HTTP utilities, timeout handling, and Retry-After parsing."""

from __future__ import annotations

import asyncio
import email.utils
import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Coroutine, Mapping
from dataclasses import dataclass
from typing import Any

from ..errors import ErrorKind, ProviderError, classify_status


class AbortError(Exception):
    """Raised when an operation is cancelled by the caller."""


class TimeoutError(Exception):
    """Raised when an operation times out."""


@dataclass
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes
    text: str | None = None

    @property
    def body_text(self) -> str:
        if self.text is not None:
            return self.text
        return self.body.decode("utf-8", errors="replace")


FetchLike = Callable[[str, dict[str, str], bytes | None, int], Coroutine[Any, Any, HttpResponse]]


def _sync_fetch(
    url: str, headers: dict[str, str], body: bytes | None, timeout_ms: int, method: str = "POST"
) -> HttpResponse:
    req = urllib.request.Request(url, data=body, headers=headers, method=method if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout_ms / 1000.0) as resp:
            return HttpResponse(
                status=resp.status,
                headers=dict(resp.headers),
                body=resp.read(),
            )
    except urllib.error.HTTPError as e:
        return HttpResponse(
            status=e.code,
            headers=dict(e.headers),
            body=e.read(),
        )


async def default_fetch(url: str, headers: dict[str, str], body: bytes | None, timeout_ms: int) -> HttpResponse:
    return await asyncio.to_thread(_sync_fetch, url, headers, body, timeout_ms)


def parse_retry_after(headers: Mapping[str, str] | None) -> int | None:
    """Read Retry-After header (seconds or HTTP-date) as milliseconds."""
    if not headers:
        return None
    raw = None
    for k, v in headers.items():
        if k.lower() == "retry-after":
            raw = v.strip()
            break
    if not raw:
        return None

    try:
        seconds = float(raw)
        return max(0, int(round(seconds * 1000)))
    except ValueError:
        pass

    try:
        timetuple = email.utils.parsedate_tz(raw)
        if timetuple is not None:
            ts = email.utils.mktime_tz(timetuple)
            return max(0, int(round((ts - time.time()) * 1000)))
    except Exception:
        pass

    return None


def to_network_error(provider: str, err: Exception) -> Exception:
    """Wrap a low-level failure into a retryable ProviderError."""
    if isinstance(err, (ProviderError, AbortError, asyncio.CancelledError)):
        return err
    is_timeout = isinstance(err, (TimeoutError, asyncio.TimeoutError))
    return ProviderError(
        provider,
        "timeout" if is_timeout else "network",
        str(err) if str(err) else type(err).__name__,
        cause=err,
    )


def is_abort_error(err: Exception) -> bool:
    """True when the error is a caller-cancellation abort (never retryable)."""
    return isinstance(err, (AbortError, asyncio.CancelledError))


def require_ok(status: int, headers: Mapping[str, str] | None, body_text: str | None, provider: str) -> None:
    """Shared non-2xx status handling and error classification."""
    if 200 <= status < 300:
        return

    kind: ErrorKind = classify_status(status)
    body: Any = None
    message = f"{provider}: HTTP {status}"
    if body_text:
        try:
            body = json.loads(body_text)
            if isinstance(body, dict):
                err_obj = body.get("error")
                if isinstance(err_obj, dict) and "message" in err_obj:
                    message = f"{provider}: {err_obj['message']}"
                elif "message" in body:
                    message = f"{provider}: {body['message']}"
        except Exception:
            pass

    retry_after_ms = parse_retry_after(headers)
    raise ProviderError(
        provider=provider,
        kind=kind,
        message=message,
        status=status,
        retry_after_ms=retry_after_ms,
        body=body,
    )
