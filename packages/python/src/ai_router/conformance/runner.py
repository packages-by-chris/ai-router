"""Conformance kit: the cross-SDK drift guard.

Runs shared JSON fixtures against provider translation functions and asserts
exact structural parity.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ..http.sse import sse_data, stream_from_chunks
from ..providers.anthropic import (
    translate_request as translate_anthropic_request,
)
from ..providers.anthropic import (
    translate_response as translate_anthropic_response,
)
from ..providers.bedrock import (
    translate_request as translate_bedrock_request,
)
from ..providers.bedrock import (
    translate_response as translate_bedrock_response,
)
from ..providers.gemini import (
    translate_request as translate_gemini_request,
)
from ..providers.gemini import (
    translate_response as translate_gemini_response,
)
from ..providers.openai import (
    translate_chunk as translate_openai_chunk,
)
from ..providers.openai import (
    translate_request as translate_openai_request,
)
from ..providers.openai import (
    translate_response as translate_openai_response,
)


def _to_plain(val: Any) -> Any:
    if hasattr(val, "to_dict"):
        return _to_plain(val.to_dict())
    if isinstance(val, dict):
        return {k: _to_plain(v) for k, v in val.items() if v is not None}
    if isinstance(val, (list, tuple)):
        return [_to_plain(x) for x in val]
    return val


def stable_json(value: Any) -> str:
    """Deterministic JSON for diffing (sorted keys, compact separators, omitted None/undefined)."""
    plain = _to_plain(value)
    return json.dumps(plain, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


async def sse_parse_handler(input_data: dict[str, Any]) -> list[str]:
    chunks = input_data.get("response", [])
    out: list[str] = []
    async for data in sse_data(stream_from_chunks(chunks)):
        out.append(data)
    return out


BUILTIN_HANDLERS: dict[str, Callable[[dict[str, Any]], Any]] = {
    "openai_request": lambda inp: translate_openai_request(
        inp.get("request", {}), inp.get("providerModel", ""), inp.get("stream", False)
    ),
    "openai_response": lambda inp: translate_openai_response(
        inp.get("response"), inp.get("providerModel", ""), inp.get("label", "openai")
    ),
    "openai_chunk": lambda inp: translate_openai_chunk(
        inp.get("response"), inp.get("providerModel", ""), inp.get("label", "openai")
    ),
    "anthropic_request": lambda inp: translate_anthropic_request(
        inp.get("request", {}), inp.get("providerModel", ""), inp.get("stream", False)
    ),
    "anthropic_response": lambda inp: translate_anthropic_response(inp.get("response"), inp.get("providerModel", "")),
    "gemini_request": lambda inp: translate_gemini_request(
        inp.get("request", {}), inp.get("providerModel", ""), inp.get("stream", False)
    ),
    "gemini_response": lambda inp: translate_gemini_response(inp.get("response"), inp.get("providerModel", "")),
    "bedrock_request": lambda inp: translate_bedrock_request(
        inp.get("request", {}), inp.get("providerModel", ""), inp.get("stream", False)
    ),
    "bedrock_response": lambda inp: translate_bedrock_response(inp.get("response"), inp.get("providerModel", "")),
    "sse_parse": sse_parse_handler,
}


@dataclass
class CaseResult:
    name: str
    ok: bool
    expected: str | None = None
    actual: str | None = None


async def run_translation_case(
    case_dict: dict[str, Any],
    handlers: dict[str, Callable[[dict[str, Any]], Any]] | None = None,
) -> CaseResult:
    """Run one translation case and compare with expected output."""
    h_map = handlers or BUILTIN_HANDLERS
    kind = case_dict.get("kind", "")
    handler = h_map.get(kind)
    name = case_dict.get("name", "")

    if not handler:
        return CaseResult(
            name=name,
            ok=False,
            expected="a registered translation handler",
            actual=f'no handler for kind "{kind}"',
        )

    inp = {
        "request": case_dict.get("request"),
        "response": case_dict.get("response"),
        "providerModel": case_dict.get("providerModel", ""),
        "stream": case_dict.get("stream") is True,
        "label": case_dict.get("label", "openai"),
    }

    res = handler(inp)
    if hasattr(res, "__await__"):
        actual_obj = await res
    else:
        actual_obj = res

    expected_str = stable_json(case_dict.get("expected"))
    actual_str = stable_json(actual_obj)

    ok = expected_str == actual_str
    return CaseResult(
        name=name,
        ok=ok,
        expected=expected_str if not ok else None,
        actual=actual_str if not ok else None,
    )
