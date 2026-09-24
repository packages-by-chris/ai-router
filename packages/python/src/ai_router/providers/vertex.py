"""Google Vertex AI provider adapter."""

from __future__ import annotations

import base64
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import AsyncIterable
from typing import Any

from ..errors import ConfigError, ProviderError
from ..http.request import require_ok, to_network_error
from ..http.sse import sse_data
from ..types import (
    ChatChunk,
    ChatRequest,
    ChatResponse,
    Delta,
    EmbeddingData,
    EmbeddingRequest,
    EmbeddingResponse,
    Usage,
)
from .gemini import (
    _classify_stream_error,
    _to_usage,
    map_finish_reason,
)
from .gemini import (
    translate_request as translate_gemini_request,
)
from .gemini import (
    translate_response as translate_gemini_response,
)
from .types import AdapterContext, NormalizedRoute, ProviderAdapter, RawRequestOptions

VERTEX_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
VERTEX_TOKEN_SCOPE = "https://www.googleapis.com/auth/cloud-platform"

_token_cache: dict[str, tuple[str, float]] = {}


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _sign_sa_jwt(client_email: str, private_key_pem: str) -> str:
    # Service account JWT signing
    now = int(time.time())
    header = _b64url_encode(json.dumps({"alg": "RS256", "typ": "JWT"}).encode("utf-8"))
    payload = _b64url_encode(
        json.dumps(
            {
                "iss": client_email,
                "scope": VERTEX_TOKEN_SCOPE,
                "aud": VERTEX_TOKEN_ENDPOINT,
                "iat": now,
                "exp": now + 3600,
            }
        ).encode("utf-8")
    )
    to_sign = f"{header}.{payload}".encode()

    # In Python, standard library doesn't include raw RSA-PKCS1v15 signing without cryptography/ssl,
    # but we can try importing cryptography if available, or use standard library openssl / ssl
    try:
        import importlib

        crypto_primitives = importlib.import_module("cryptography.hazmat.primitives")
        crypto_asymmetric = importlib.import_module("cryptography.hazmat.primitives.asymmetric.padding")
        hashes = crypto_primitives.hashes
        serialization = crypto_primitives.serialization
        padding = crypto_asymmetric.padding

        priv_key = serialization.load_pem_private_key(private_key_pem.encode("utf-8"), password=None)
        sig = priv_key.sign(to_sign, padding.PKCS1v15(), hashes.SHA256())
        return f"{header}.{payload}.{_b64url_encode(sig)}"
    except Exception:
        # Fallback or pass assertion if key is already token
        return ""


def resolve_vertex_token(api_key: str) -> str:
    """Resolve route apiKey -> bearer token (cached until shortly before expiry)."""
    try:
        key_json = json.loads(api_key)
    except Exception:
        return api_key

    if not isinstance(key_json, dict) or "client_email" not in key_json or "private_key" not in key_json:
        return api_key

    client_email = key_json["client_email"]
    private_key = key_json["private_key"]
    cache_key = f"{client_email}:{len(private_key)}"
    cached = _token_cache.get(cache_key)
    if cached and time.time() < cached[1]:
        return cached[0]

    assertion = _sign_sa_jwt(client_email, private_key)
    if not assertion:
        return api_key

    data = urllib.parse.urlencode(
        {
            "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
            "assertion": assertion,
        }
    ).encode("utf-8")
    req = urllib.request.Request(VERTEX_TOKEN_ENDPOINT, data=data, method="POST")
    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        token = res["access_token"]
        expires_in = res.get("expires_in", 3600)
        _token_cache[cache_key] = (token, time.time() + expires_in - 60)
        return token


def _require_vertex(route: NormalizedRoute) -> tuple[str, str, str]:
    if not route.region or not route.project:
        raise ConfigError(f'route "{route.id}": vertex provider requires region and project')
    return route.region, route.project, route.apiVersion or "v1"


def _vertex_url(route: NormalizedRoute, method: str) -> str:
    region, project, api_version = _require_vertex(route)
    return (
        f"https://{region}-aiplatform.googleapis.com/{api_version}"
        f"/projects/{urllib.parse.quote(project)}"
        f"/locations/{urllib.parse.quote(region)}"
        f"/publishers/google/models/{urllib.parse.quote(route.model)}:{method}"
    )


class VertexAdapter(ProviderAdapter):
    @property
    def id(self) -> str:
        return "vertex"

    def headers(self, route: NormalizedRoute, key: str) -> dict[str, str]:
        token = resolve_vertex_token(key)
        return {
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
            **(route.headers or {}),
        }

    async def complete(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> ChatResponse:
        url = _vertex_url(route, "generateContent")
        headers = self.headers(route, key)
        body_bytes = json.dumps(translate_gemini_request(req, route.model, False)).encode("utf-8")
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")

        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            with urllib.request.urlopen(req_obj, timeout=timeout_sec) as resp:
                status = resp.status
                resp_headers = dict(resp.headers)
                resp_text = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            require_ok(e.code, dict(e.headers), e.read().decode("utf-8", errors="replace"), "vertex")
            raise
        except Exception as e:
            raise to_network_error("vertex", e)

        require_ok(status, resp_headers, resp_text, "vertex")
        return translate_gemini_response(json.loads(resp_text), route.model)

    async def stream(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> AsyncIterable[ChatChunk]:
        url = _vertex_url(route, "streamGenerateContent?alt=sse")
        headers = self.headers(route, key)
        body_bytes = json.dumps(translate_gemini_request(req, route.model, True)).encode("utf-8")
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")

        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            resp = urllib.request.urlopen(req_obj, timeout=timeout_sec)
            require_ok(resp.status, dict(resp.headers), None, "vertex")
        except urllib.error.HTTPError as e:
            require_ok(e.code, dict(e.headers), e.read().decode("utf-8", errors="replace"), "vertex")
            raise
        except Exception as e:
            raise to_network_error("vertex", e)

        async def stream_generator() -> AsyncIterable[ChatChunk]:
            served_model = route.model
            role_sent = False
            finish: str | None = None
            usage: Usage | None = None

            async def read_lines() -> AsyncIterable[str]:
                try:
                    while True:
                        line = resp.readline()
                        if not line:
                            break
                        yield line.decode("utf-8", errors="replace")
                finally:
                    resp.close()

            async for data in sse_data(read_lines()):
                try:
                    ev = json.loads(data)
                except Exception:
                    continue

                if isinstance(ev.get("error"), dict):
                    err = ev["error"]
                    kind = _classify_stream_error(err.get("status"))
                    msg = err.get("message", "stream error")
                    raise ProviderError("vertex", kind, f"vertex: {msg}", body=ev)

                candidates = ev.get("candidates", [])
                candidate = candidates[0] if candidates and isinstance(candidates[0], dict) else None
                if candidate:
                    content = candidate.get("content", {})
                    parts = content.get("parts", []) if isinstance(content.get("parts"), list) else []
                    for part in parts:
                        if not isinstance(part, dict):
                            continue
                        if not role_sent:
                            role_sent = True
                            yield ChatChunk(
                                id="",
                                model=served_model,
                                provider="vertex",
                                delta=Delta(role="assistant"),
                                finish_reason=None,
                            )
                        p_text = part.get("text")
                        if isinstance(p_text, str) and p_text != "":
                            if part.get("thought") is True:
                                yield ChatChunk(
                                    id="",
                                    model=served_model,
                                    provider="vertex",
                                    delta=Delta(reasoning=p_text),
                                    finish_reason=None,
                                )
                            else:
                                yield ChatChunk(
                                    id="",
                                    model=served_model,
                                    provider="vertex",
                                    delta=Delta(content=p_text),
                                    finish_reason=None,
                                )
                        fc = part.get("functionCall")
                        if isinstance(fc, dict):
                            d_fc = {
                                "index": 0,
                                "type": "function",
                                "function": {
                                    "name": fc.get("name", ""),
                                    "arguments": json.dumps(fc.get("args", {})),
                                },
                            }
                            if fc.get("id"):
                                d_fc["id"] = fc["id"]
                            yield ChatChunk(
                                id="",
                                model=served_model,
                                provider="vertex",
                                delta=Delta(tool_calls=[d_fc]),
                                finish_reason=None,
                            )
                    mapped = map_finish_reason(candidate.get("finishReason"))
                    if mapped is not None:
                        finish = mapped

                meta = _to_usage(ev.get("usageMetadata"))
                if meta:
                    usage = meta
                if isinstance(ev.get("modelVersion"), str):
                    served_model = ev["modelVersion"]

            if finish is not None or usage is not None:
                yield ChatChunk(
                    id="", model=served_model, provider="vertex", delta=Delta(), finish_reason=finish, usage=usage
                )

        return stream_generator()

    async def raw(
        self,
        route: NormalizedRoute,
        key: str,
        opts: RawRequestOptions,
        ctx: AdapterContext | None = None,
    ) -> Any:
        default_path = f"/publishers/google/models/{urllib.parse.quote(route.model)}:generateContent"
        region, project, api_version = _require_vertex(route)
        base = f"https://{region}-aiplatform.googleapis.com/{api_version}/projects/{urllib.parse.quote(project)}/locations/{urllib.parse.quote(region)}"
        url = f"{base}{opts.path or default_path}"
        headers = {**self.headers(route, key), **(opts.headers or {})}
        body_bytes = None
        if opts.body is not None:
            body_bytes = (
                opts.body.encode("utf-8") if isinstance(opts.body, str) else json.dumps(opts.body).encode("utf-8")
            )
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method=opts.method)
        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            return urllib.request.urlopen(req_obj, timeout=timeout_sec)
        except Exception as e:
            raise to_network_error("vertex", e)

    async def embed(
        self,
        route: NormalizedRoute,
        key: str,
        req: EmbeddingRequest,
        ctx: AdapterContext | None = None,
    ) -> EmbeddingResponse:
        inputs = req.input if isinstance(req.input, list) else [req.input]
        url = _vertex_url(route, "predict")
        headers = self.headers(route, key)
        body_bytes = json.dumps({"instances": [{"content": text} for text in inputs]}).encode("utf-8")
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")

        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            with urllib.request.urlopen(req_obj, timeout=timeout_sec) as resp:
                status = resp.status
                resp_headers = dict(resp.headers)
                resp_text = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            require_ok(e.code, dict(e.headers), e.read().decode("utf-8", errors="replace"), "vertex")
            raise
        except Exception as e:
            raise to_network_error("vertex", e)

        require_ok(status, resp_headers, resp_text, "vertex")
        j = json.loads(resp_text)
        raw = j.get("predictions", []) if isinstance(j.get("predictions"), list) else []
        data = [
            EmbeddingData(
                index=i,
                embedding=(
                    d.get("embeddings", {}).get("values", [])
                    if isinstance(d, dict) and isinstance(d.get("embeddings"), dict)
                    else []
                ),
            )
            for i, d in enumerate(raw)
        ]
        return EmbeddingResponse(
            object="list",
            model=route.model,
            provider="vertex",
            data=data,
        )
