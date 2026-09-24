"""Anthropic Messages API provider adapter."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from collections.abc import AsyncIterable
from typing import Any

from ..errors import ErrorKind, ProviderError
from ..http.request import require_ok, to_network_error
from ..http.sse import sse_data
from ..types import (
    ChatChunk,
    ChatMessage,
    ChatRequest,
    ChatResponse,
    Choice,
    Delta,
    EmbeddingRequest,
    EmbeddingResponse,
    FunctionCall,
    ToolCall,
    Usage,
)
from .types import AdapterContext, NormalizedRoute, ProviderAdapter, RawRequestOptions

ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com/v1"
ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_DEFAULT_MAX_TOKENS = 4096

ANTHROPIC_THINKING_BUDGETS: dict[str, int] = {
    "low": 4096,
    "medium": 12288,
    "high": 24576,
}


def base_url(route: NormalizedRoute) -> str:
    return (route.baseUrl or ANTHROPIC_DEFAULT_BASE_URL).rstrip("/")


def _wants_cache(msg: Any) -> bool:
    opts = getattr(msg, "providerOptions", None) if not isinstance(msg, dict) else msg.get("providerOptions")
    if not isinstance(opts, dict):
        return False
    anthropic_opts = opts.get("anthropic")
    if isinstance(anthropic_opts, dict):
        return anthropic_opts.get("cache_control") is True
    return False


def _image_block(url: str) -> dict[str, Any] | None:
    data_uri = re.match(r"^data:([^;,]+);base64,(.*)$", url, re.IGNORECASE)
    if data_uri:
        return {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": data_uri.group(1),
                "data": data_uri.group(2),
            },
        }
    if re.match(r"^https?://", url, re.IGNORECASE):
        return {"type": "image", "source": {"type": "url", "url": url}}
    return None


def _push_unified_content(push_fn: Any, role: str, content: Any) -> None:
    if isinstance(content, str):
        if len(content) > 0:
            push_fn(role, {"type": "text", "text": content})
        return
    if isinstance(content, list):
        for part in content:
            p_type = part.get("type") if isinstance(part, dict) else getattr(part, "type", None)
            if p_type == "text":
                text = part.get("text") if isinstance(part, dict) else getattr(part, "text", "")
                if text and len(text) > 0:
                    push_fn(role, {"type": "text", "text": text})
            elif p_type == "image_url":
                img_url_obj = part.get("image_url") if isinstance(part, dict) else getattr(part, "image_url", None)
                url = img_url_obj.get("url") if isinstance(img_url_obj, dict) else getattr(img_url_obj, "url", "")
                if url:
                    block = _image_block(url)
                    if block:
                        push_fn(role, block)


def translate_request(
    req: ChatRequest | dict[str, Any],
    provider_model: str,
    stream: bool,
) -> dict[str, Any]:
    """Unified ChatRequest -> Anthropic Messages API wire format."""
    req_dict = req.to_dict() if isinstance(req, ChatRequest) else dict(req)
    messages = req_dict.get("messages", [])

    system_blocks: list[dict[str, Any]] = []
    system_has_cache_marker = False
    turns: list[dict[str, Any]] = []

    def push(role: str, block: dict[str, Any]) -> None:
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"].append(block)
        else:
            turns.append({"role": role, "content": [block]})

    for msg in messages:
        role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", None)
        content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
        flag = _wants_cache(msg)

        if role == "system":
            if flag:
                system_has_cache_marker = True
            if isinstance(content, str):
                if len(content) > 0:
                    b: dict[str, Any] = {"type": "text", "text": content}
                    if flag:
                        b["cache_control"] = {"type": "ephemeral"}
                    system_blocks.append(b)
            elif isinstance(content, list):
                parts = [
                    p for p in content if (p.get("type") if isinstance(p, dict) else getattr(p, "type", None)) == "text"
                ]
                for i, p in enumerate(parts):
                    text = p.get("text") if isinstance(p, dict) else getattr(p, "text", "")
                    if text and len(text) > 0:
                        b = {"type": "text", "text": text}
                        if flag and i == len(parts) - 1:
                            b["cache_control"] = {"type": "ephemeral"}
                        system_blocks.append(b)
            continue

        if role == "tool":
            result_text = ""
            if isinstance(content, str):
                result_text = content
            elif isinstance(content, list):
                result_text = "\n".join(
                    p.get("text", "") if isinstance(p, dict) else getattr(p, "text", "")
                    for p in content
                    if (p.get("type") if isinstance(p, dict) else getattr(p, "type", None)) == "text"
                )
            tool_call_id = (
                msg.get("tool_call_id", "") if isinstance(msg, dict) else (getattr(msg, "tool_call_id", "") or "")
            )
            push(
                "user",
                {
                    "type": "tool_result",
                    "tool_use_id": tool_call_id,
                    "content": result_text,
                },
            )
            continue

        turn_role = "assistant" if role == "assistant" else "user"
        local: list[dict[str, Any]] = []

        def local_push(r: str, block: dict[str, Any]) -> None:
            if r == turn_role:
                local.append(block)

        _push_unified_content(local_push, turn_role, content)

        tool_calls = msg.get("tool_calls", []) if isinstance(msg, dict) else (getattr(msg, "tool_calls", None) or [])
        for tc in tool_calls:
            tc_dict = tc.to_dict() if hasattr(tc, "to_dict") else tc
            fn = tc_dict.get("function", {}) if isinstance(tc_dict, dict) else {}
            args_str = fn.get("arguments", "{}") if isinstance(fn, dict) else "{}"
            try:
                args = json.loads(args_str or "{}")
            except Exception:
                args = {}
            local.append(
                {
                    "type": "tool_use",
                    "id": tc_dict.get("id", ""),
                    "name": fn.get("name", "") if isinstance(fn, dict) else "",
                    "input": args,
                }
            )

        if flag and len(local) > 0:
            local[-1]["cache_control"] = {"type": "ephemeral"}

        if len(local) > 0:
            if turns and turns[-1]["role"] == turn_role:
                turns[-1]["content"].extend(local)
            else:
                turns.append({"role": turn_role, "content": local})

    body: dict[str, Any] = {
        "model": provider_model,
        "max_tokens": req_dict.get("max_tokens") or ANTHROPIC_DEFAULT_MAX_TOKENS,
        "messages": turns,
    }

    if system_blocks:
        if system_has_cache_marker:
            body["system"] = system_blocks
        else:
            body["system"] = "\n\n".join(b["text"] for b in system_blocks)

    if req_dict.get("temperature") is not None:
        body["temperature"] = req_dict["temperature"]
    if req_dict.get("top_p") is not None:
        body["top_p"] = req_dict["top_p"]
    if req_dict.get("stop") is not None:
        stop = req_dict["stop"]
        body["stop_sequences"] = stop if isinstance(stop, list) else [stop]

    tools = req_dict.get("tools")
    tool_choice = req_dict.get("tool_choice")
    if tool_choice != "none" and tools and len(tools) > 0:
        anthropic_tools: list[dict[str, Any]] = []
        for t in tools:
            t_dict = t.to_dict() if hasattr(t, "to_dict") else t
            fn = t_dict.get("function", {}) if isinstance(t_dict, dict) else {}
            item: dict[str, Any] = {
                "name": fn.get("name", ""),
                "input_schema": fn.get("parameters", {}),
            }
            if "description" in fn and fn["description"] is not None:
                item["description"] = fn["description"]
            anthropic_tools.append(item)
        body["tools"] = anthropic_tools

        if tool_choice == "auto":
            body["tool_choice"] = {"type": "auto"}
        elif tool_choice == "required":
            body["tool_choice"] = {"type": "any"}
        elif isinstance(tool_choice, dict):
            fn_obj = tool_choice.get("function", {})
            name = fn_obj.get("name") if isinstance(fn_obj, dict) else ""
            if name:
                body["tool_choice"] = {"type": "tool", "name": name}

    reasoning_effort = req_dict.get("reasoning_effort")
    if reasoning_effort is not None:
        budget = ANTHROPIC_THINKING_BUDGETS.get(reasoning_effort, 4096)
        body["thinking"] = {"type": "enabled", "budget_tokens": budget}
        body.pop("temperature", None)
        body.pop("top_p", None)
        cur_max = body.get("max_tokens", ANTHROPIC_DEFAULT_MAX_TOKENS)
        if cur_max <= budget:
            body["max_tokens"] = budget + 1024
        tc_cur = body.get("tool_choice")
        if isinstance(tc_cur, dict) and tc_cur.get("type") != "auto":
            body.pop("tool_choice", None)

    if stream:
        body["stream"] = True

    opts = req_dict.get("providerOptions")
    if isinstance(opts, dict):
        extra = opts.get("anthropic")
        if isinstance(extra, dict):
            body.update(extra)

    return body


def map_finish_reason(stop_reason: Any) -> str | None:
    """Anthropic stop_reason -> OpenAI-style finish_reason."""
    if stop_reason in ("end_turn", "stop_sequence", "pause_turn"):
        return "stop"
    if stop_reason == "max_tokens":
        return "length"
    if stop_reason == "tool_use":
        return "tool_calls"
    if stop_reason == "refusal":
        return "content_filter"
    return str(stop_reason) if isinstance(stop_reason, str) else None


def _to_usage(v: Any) -> Usage | None:
    if not isinstance(v, dict):
        return None
    inp = v.get("input_tokens")
    out = v.get("output_tokens")
    if not isinstance(inp, int) or not isinstance(out, int):
        return None
    cache_read = v.get("cache_read_input_tokens") or 0
    cache_write = v.get("cache_creation_input_tokens") or 0
    total = inp + out + cache_read + cache_write
    return Usage(
        prompt_tokens=inp,
        completion_tokens=out,
        total_tokens=total,
        cached_tokens=cache_read if cache_read > 0 else None,
        cache_write_tokens=cache_write if cache_write > 0 else None,
    )


def translate_response(json_data: Any, provider_model: str) -> ChatResponse:
    """Anthropic response -> unified ChatResponse."""
    j = json_data if isinstance(json_data, dict) else {}
    blocks = j.get("content", []) if isinstance(j.get("content"), list) else []

    text = ""
    reasoning = ""
    tool_calls: list[ToolCall] = []

    for block in blocks:
        if not isinstance(block, dict):
            continue
        b_type = block.get("type")
        if b_type == "text" and isinstance(block.get("text"), str):
            text += block["text"]
        elif b_type == "thinking" and isinstance(block.get("thinking"), str):
            reasoning += block["thinking"]
        elif b_type == "tool_use":
            tool_calls.append(
                ToolCall(
                    id=block.get("id", ""),
                    type="function",
                    function=FunctionCall(
                        name=block.get("name", ""),
                        arguments=json.dumps(block.get("input", {}), separators=(",", ":")),
                    ),
                )
            )

    msg = ChatMessage(
        role="assistant",
        content=text if text != "" else (None if len(tool_calls) > 0 else ""),
        reasoning=reasoning if reasoning != "" else None,
        tool_calls=tool_calls if len(tool_calls) > 0 else None,
    )

    return ChatResponse(
        id=j.get("id", "") if isinstance(j.get("id"), str) else "",
        model=j.get("model", provider_model) if isinstance(j.get("model"), str) else provider_model,
        provider="anthropic",
        created=0,
        usage=_to_usage(j.get("usage")),
        choices=[
            Choice(
                index=0,
                finish_reason=map_finish_reason(j.get("stop_reason")),
                message=msg,
            )
        ],
    )


def _classify_stream_error_type(err_type: Any) -> ErrorKind:
    if err_type == "invalid_request_error":
        return "invalid_request"
    if err_type == "authentication_error":
        return "auth"
    if err_type == "permission_error":
        return "permission"
    if err_type == "not_found_error":
        return "not_found"
    if err_type == "rate_limit_error":
        return "rate_limit"
    if err_type in ("overloaded_error", "api_error"):
        return "server"
    return "unknown"


class AnthropicAdapter(ProviderAdapter):
    @property
    def id(self) -> str:
        return "anthropic"

    def headers(self, route: NormalizedRoute, key: str) -> dict[str, str]:
        return {
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": ANTHROPIC_VERSION,
            **(route.headers or {}),
        }

    async def complete(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> ChatResponse:
        from ..http.request import default_fetch

        url = f"{base_url(route)}/messages"
        headers = self.headers(route, key)
        body_bytes = json.dumps(translate_request(req, route.model, False)).encode("utf-8")
        fetch_fn = ctx.fetch if (ctx and ctx.fetch) else default_fetch
        timeout_ms = route.timeoutMs or 30000
        try:
            resp = await fetch_fn(url, headers, body_bytes, timeout_ms)
        except Exception as e:
            raise to_network_error("anthropic", e)

        require_ok(resp.status, resp.headers, resp.body_text, "anthropic")
        return translate_response(json.loads(resp.body_text), route.model)

    async def stream(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> AsyncIterable[ChatChunk]:
        url = f"{base_url(route)}/messages"
        headers = self.headers(route, key)
        body_bytes = json.dumps(translate_request(req, route.model, True)).encode("utf-8")
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")

        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            resp = urllib.request.urlopen(req_obj, timeout=timeout_sec)
            require_ok(resp.status, dict(resp.headers), None, "anthropic")
        except urllib.error.HTTPError as e:
            require_ok(e.code, dict(e.headers), e.read().decode("utf-8", errors="replace"), "anthropic")
            raise
        except Exception as e:
            raise to_network_error("anthropic", e)

        async def stream_generator() -> AsyncIterable[ChatChunk]:
            msg_id = ""
            served_model = route.model
            input_tokens: int | None = None
            output_tokens: int | None = None
            cache_read = 0
            cache_write = 0
            finish: str | None = None

            def make_chunk(delta: Delta, finish_r: str | None = None, usage_obj: Usage | None = None) -> ChatChunk:
                return ChatChunk(
                    id=msg_id,
                    model=served_model,
                    provider="anthropic",
                    delta=delta,
                    finish_reason=finish_r,
                    usage=usage_obj,
                )

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

                ev_type = ev.get("type")
                if ev_type == "message_start":
                    message = ev.get("message", {})
                    if isinstance(message.get("id"), str):
                        msg_id = message["id"]
                    if isinstance(message.get("model"), str):
                        served_model = message["model"]
                    usage = message.get("usage", {})
                    if isinstance(usage.get("input_tokens"), int):
                        input_tokens = usage["input_tokens"]
                    if isinstance(usage.get("cache_read_input_tokens"), int):
                        cache_read = usage["cache_read_input_tokens"]
                    if isinstance(usage.get("cache_creation_input_tokens"), int):
                        cache_write = usage["cache_creation_input_tokens"]
                    yield make_chunk(Delta(role="assistant"))
                elif ev_type == "content_block_start":
                    block = ev.get("content_block", {})
                    if block.get("type") == "tool_use":
                        idx = ev.get("index", 0)
                        yield make_chunk(
                            Delta(
                                tool_calls=[
                                    {
                                        "index": idx,
                                        "id": block.get("id", ""),
                                        "type": "function",
                                        "function": {"name": block.get("name", ""), "arguments": ""},
                                    }
                                ]
                            )
                        )
                elif ev_type == "content_block_delta":
                    delta = ev.get("delta", {})
                    idx = ev.get("index", 0)
                    if delta.get("type") == "text_delta" and delta.get("text"):
                        yield make_chunk(Delta(content=delta["text"]))
                    elif delta.get("type") == "thinking_delta" and delta.get("thinking"):
                        yield make_chunk(Delta(reasoning=delta["thinking"]))
                    elif delta.get("type") == "input_json_delta":
                        yield make_chunk(
                            Delta(
                                tool_calls=[
                                    {
                                        "index": idx,
                                        "function": {"arguments": delta.get("partial_json", "")},
                                    }
                                ]
                            )
                        )
                elif ev_type == "message_delta":
                    delta = ev.get("delta", {})
                    if delta.get("stop_reason") is not None:
                        finish = map_finish_reason(delta["stop_reason"])
                    usage = ev.get("usage", {})
                    if isinstance(usage.get("output_tokens"), int):
                        output_tokens = usage["output_tokens"]
                elif ev_type == "message_stop":
                    total = (input_tokens or 0) + (output_tokens or 0) + cache_read + cache_write
                    usage_obj = None
                    if input_tokens is not None or output_tokens is not None:
                        usage_obj = Usage(
                            prompt_tokens=input_tokens or 0,
                            completion_tokens=output_tokens or 0,
                            total_tokens=total,
                            cached_tokens=cache_read if cache_read > 0 else None,
                            cache_write_tokens=cache_write if cache_write > 0 else None,
                        )
                    yield make_chunk(Delta(), finish_r=finish, usage_obj=usage_obj)
                    return
                elif ev_type == "error":
                    err = ev.get("error", {})
                    kind = _classify_stream_error_type(err.get("type"))
                    msg = err.get("message", "stream error")
                    raise ProviderError("anthropic", kind, f"anthropic: {msg}", body=ev)

        return stream_generator()

    async def raw(
        self,
        route: NormalizedRoute,
        key: str,
        opts: RawRequestOptions,
        ctx: AdapterContext | None = None,
    ) -> Any:
        url = f"{base_url(route)}{opts.path or '/messages'}"
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
            raise to_network_error("anthropic", e)

    async def embed(
        self,
        route: NormalizedRoute,
        key: str,
        req: EmbeddingRequest,
        ctx: AdapterContext | None = None,
    ) -> EmbeddingResponse:
        raise ProviderError(self.id, "invalid_request", f"embeddings not supported by {self.id}")
