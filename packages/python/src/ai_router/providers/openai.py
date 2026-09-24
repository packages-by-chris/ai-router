"""OpenAI and OpenAI-compatible provider adapter."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from collections.abc import AsyncIterable, Sequence
from typing import Any

from ..errors import ProviderError
from ..http.request import require_ok, to_network_error
from ..http.sse import sse_data
from ..types import (
    ChatChunk,
    ChatMessage,
    ChatRequest,
    ChatResponse,
    Choice,
    Delta,
    EmbeddingData,
    EmbeddingRequest,
    EmbeddingResponse,
    Role,
    Usage,
)
from .types import AdapterContext, NormalizedRoute, ProviderAdapter, RawRequestOptions

OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1"
OPENAI_OPTION_NAMESPACES = ("openai",)


def provider_label(route: NormalizedRoute) -> str:
    """Identity used in unified responses/errors."""
    return route.id if route.provider == "openai-compatible" else route.provider


def base_url(route: NormalizedRoute) -> str:
    return (route.baseUrl or OPENAI_DEFAULT_BASE_URL).rstrip("/")


def merge_provider_options(
    body: dict[str, Any],
    req: ChatRequest,
    namespaces: Sequence[str],
) -> dict[str, Any]:
    """Shallow-merge providerOptions namespaces into the wire body."""
    opts = getattr(req, "providerOptions", None) if not isinstance(req, dict) else req.get("providerOptions")
    if not opts:
        return body
    for ns in namespaces:
        extra = opts.get(ns) if isinstance(opts, dict) else getattr(opts, ns, None)
        if extra and isinstance(extra, dict):
            body.update(extra)
    return body


def wire_messages(messages: Sequence[Any]) -> list[dict[str, Any]]:
    """Wire-safe messages stripping engine-only fields."""
    res: list[dict[str, Any]] = []
    for m in messages:
        if isinstance(m, ChatMessage):
            entry: dict[str, Any] = {
                "role": m.role,
                "content": m.content,
            }
            if m.name is not None:
                entry["name"] = m.name
            if m.tool_calls is not None:
                entry["tool_calls"] = [tc.to_dict() if hasattr(tc, "to_dict") else tc for tc in m.tool_calls]
            if m.tool_call_id is not None:
                entry["tool_call_id"] = m.tool_call_id
            res.append(entry)
        elif isinstance(m, dict):
            entry = {
                "role": m.get("role"),
                "content": m.get("content"),
            }
            if "name" in m and m["name"] is not None:
                entry["name"] = m["name"]
            if "tool_calls" in m and m["tool_calls"] is not None:
                entry["tool_calls"] = m["tool_calls"]
            if "tool_call_id" in m and m["tool_call_id"] is not None:
                entry["tool_call_id"] = m["tool_call_id"]
            res.append(entry)
    return res


def translate_request(
    req: ChatRequest | dict[str, Any],
    provider_model: str,
    stream: bool,
) -> dict[str, Any]:
    """Translates a unified ChatRequest into OpenAI chat completion wire JSON body."""
    req_dict = req.to_dict() if isinstance(req, ChatRequest) else dict(req)
    body: dict[str, Any] = {
        "model": provider_model,
        "messages": wire_messages(req_dict.get("messages", [])),
    }

    for key in (
        "tools",
        "tool_choice",
        "temperature",
        "top_p",
        "max_tokens",
        "stop",
        "response_format",
        "reasoning_effort",
        "user",
    ):
        val = req_dict.get(key)
        if val is not None:
            body[key] = val

    if stream:
        body["stream"] = True
        opts = req_dict.get("providerOptions", {})
        openai_opts = opts.get("openai", {}) if isinstance(opts, dict) else {}
        if "stream_options" not in openai_opts:
            body["stream_options"] = {"include_usage": True}

    merged = merge_provider_options(
        body,
        req
        if isinstance(req, ChatRequest)
        else ChatRequest(**{k: v for k, v in req.items() if k in ChatRequest.__dataclass_fields__}),
        OPENAI_OPTION_NAMESPACES,
    )

    if merged.get("stream_options") is None and "stream_options" in merged:
        del merged["stream_options"]

    return merged


def usage_details(u: dict[str, Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    prompt_details = u.get("prompt_tokens_details")
    if isinstance(prompt_details, dict) and isinstance(prompt_details.get("cached_tokens"), int):
        out["cached_tokens"] = prompt_details["cached_tokens"]
    completion_details = u.get("completion_tokens_details")
    if isinstance(completion_details, dict) and isinstance(completion_details.get("reasoning_tokens"), int):
        out["reasoning_tokens"] = completion_details["reasoning_tokens"]
    return out


def to_usage(v: Any) -> Usage | None:
    if not isinstance(v, dict):
        return None
    pt = v.get("prompt_tokens")
    ct = v.get("completion_tokens", 0)
    tt = v.get("total_tokens")
    if not isinstance(pt, int) or not isinstance(tt, int):
        return None
    if not isinstance(ct, int):
        ct = 0
    details = usage_details(v)
    return Usage(
        prompt_tokens=pt,
        completion_tokens=ct,
        total_tokens=tt,
        cached_tokens=details.get("cached_tokens"),
        reasoning_tokens=details.get("reasoning_tokens"),
    )


def to_role(v: Any) -> Role:
    return v if v in ("system", "user", "assistant", "tool") else "assistant"


def translate_response(
    json_data: Any,
    provider_model: str,
    label: str = "openai",
) -> ChatResponse:
    """Translates an OpenAI response JSON into a unified ChatResponse."""
    j = json_data if isinstance(json_data, dict) else {}
    choices_raw = j.get("choices", []) if isinstance(j.get("choices"), list) else []

    choices: list[Choice] = []
    for i, c in enumerate(choices_raw):
        ch = c if isinstance(c, dict) else {}
        msg_raw = ch.get("message", {}) if isinstance(ch.get("message"), dict) else {}
        content_val = msg_raw.get("content")
        content: str | None
        if isinstance(content_val, str):
            content = content_val
        elif content_val is None:
            content = None
        else:
            content = ""

        msg = ChatMessage(
            role=to_role(msg_raw.get("role")),
            content=content,
            name=msg_raw.get("name"),
            tool_calls=msg_raw.get("tool_calls"),
            tool_call_id=msg_raw.get("tool_call_id"),
        )
        choices.append(
            Choice(
                index=ch.get("index", i) if isinstance(ch.get("index"), int) else i,
                finish_reason=ch.get("finish_reason") if isinstance(ch.get("finish_reason"), str) else None,
                message=msg,
            )
        )

    return ChatResponse(
        id=j.get("id", "") if isinstance(j.get("id"), str) else "",
        model=j.get("model", provider_model) if isinstance(j.get("model"), str) else provider_model,
        provider=label,
        created=j.get("created", 0) if isinstance(j.get("created"), int) else 0,
        usage=to_usage(j.get("usage")),
        choices=choices,
    )


def translate_chunk(
    json_data: Any,
    provider_model: str,
    label: str = "openai",
) -> ChatChunk | None:
    """Translates an OpenAI stream chunk JSON into a unified ChatChunk or None."""
    j = json_data if isinstance(json_data, dict) else {}
    choices_raw = j.get("choices", []) if isinstance(j.get("choices"), list) else []
    first = choices_raw[0] if choices_raw and isinstance(choices_raw[0], dict) else None

    delta = Delta()
    finish_reason: str | None = None
    if first is not None:
        d = first.get("delta", {}) if isinstance(first.get("delta"), dict) else {}
        if "role" in d and d["role"] is not None:
            delta.role = to_role(d["role"])
        if "content" in d and isinstance(d["content"], str):
            delta.content = d["content"]

        reasoning = d.get("reasoning")
        if isinstance(reasoning, str) and reasoning != "":
            delta.reasoning = reasoning
        else:
            reasoning_content = d.get("reasoning_content")
            if isinstance(reasoning_content, str) and reasoning_content != "":
                delta.reasoning = reasoning_content

        if "tool_calls" in d and isinstance(d["tool_calls"], list):
            delta.tool_calls = d["tool_calls"]

        if isinstance(first.get("finish_reason"), str):
            finish_reason = first["finish_reason"]

    usage = to_usage(j.get("usage"))
    if first is None and usage is None:
        return None

    return ChatChunk(
        id=j.get("id", "") if isinstance(j.get("id"), str) else "",
        model=j.get("model", provider_model) if isinstance(j.get("model"), str) else provider_model,
        provider=label,
        delta=delta,
        finish_reason=finish_reason,
        usage=usage,
    )


class OpenAIAdapter(ProviderAdapter):
    @property
    def id(self) -> str:
        return "openai"

    def label_for(self, route: NormalizedRoute) -> str:
        return provider_label(route)

    def base(self, route: NormalizedRoute) -> str:
        return base_url(route)

    def chat_endpoint(self, route: NormalizedRoute) -> str:
        return f"{self.base(route)}/chat/completions"

    def embed_endpoint(self, route: NormalizedRoute) -> str:
        return f"{self.base(route)}/embeddings"

    def raw_endpoint(self, route: NormalizedRoute, opts: RawRequestOptions) -> str:
        return f"{self.base(route)}{opts.path or '/chat/completions'}"

    def auth_headers(self, route: NormalizedRoute, key: str) -> dict[str, str]:
        if route.authHeaderName:
            return {route.authHeaderName: key}
        return {"authorization": f"Bearer {key}"}

    def option_namespaces(self) -> Sequence[str]:
        return OPENAI_OPTION_NAMESPACES

    def build_body(self, req: ChatRequest, provider_model: str, stream: bool) -> dict[str, Any]:
        body = translate_request(req, provider_model, stream)
        return merge_provider_options(body, req, self.option_namespaces())

    async def complete(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> ChatResponse:
        from ..http.request import default_fetch

        label = self.label_for(route)
        url = self.chat_endpoint(route)
        headers = {
            "content-type": "application/json",
            **self.auth_headers(route, key),
            **(route.headers or {}),
        }
        body_bytes = json.dumps(self.build_body(req, route.model, False)).encode("utf-8")
        fetch_fn = ctx.fetch if (ctx and ctx.fetch) else default_fetch
        timeout_ms = route.timeoutMs or 30000
        try:
            resp = await fetch_fn(url, headers, body_bytes, timeout_ms)
        except Exception as e:
            raise to_network_error(label, e)

        require_ok(resp.status, resp.headers, resp.body_text, label)
        return translate_response(json.loads(resp.body_text), route.model, label)

    async def stream(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> AsyncIterable[ChatChunk]:
        label = self.label_for(route)
        url = self.chat_endpoint(route)
        headers = {
            "content-type": "application/json",
            **self.auth_headers(route, key),
            **(route.headers or {}),
        }
        body_bytes = json.dumps(self.build_body(req, route.model, True)).encode("utf-8")
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")

        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            resp = urllib.request.urlopen(req_obj, timeout=timeout_sec)
            require_ok(resp.status, dict(resp.headers), None, label)
        except urllib.error.HTTPError as e:
            require_ok(e.code, dict(e.headers), e.read().decode("utf-8", errors="replace"), label)
            raise
        except Exception as e:
            raise to_network_error(label, e)

        async def stream_generator() -> AsyncIterable[ChatChunk]:
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
                if data == "[DONE]":
                    return
                try:
                    data_json = json.loads(data)
                except Exception:
                    continue

                if isinstance(data_json, dict) and "error" in data_json and isinstance(data_json["error"], dict):
                    err_msg = data_json["error"].get("message", "mid-stream error")
                    raise ProviderError(label, "server", f"{label}: {err_msg}", body=data_json)

                chunk = translate_chunk(data_json, route.model, label)
                if chunk is not None:
                    yield chunk

        return stream_generator()

    async def raw(
        self,
        route: NormalizedRoute,
        key: str,
        opts: RawRequestOptions,
        ctx: AdapterContext | None = None,
    ) -> Any:
        label = self.label_for(route)
        url = self.raw_endpoint(route, opts)
        headers = {
            "content-type": "application/json",
            **self.auth_headers(route, key),
            **(route.headers or {}),
            **(opts.headers or {}),
        }
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
            raise to_network_error(label, e)

    async def embed(
        self,
        route: NormalizedRoute,
        key: str,
        req: EmbeddingRequest,
        ctx: AdapterContext | None = None,
    ) -> EmbeddingResponse:
        from ..http.request import default_fetch

        label = self.label_for(route)
        url = self.embed_endpoint(route)
        headers = {
            "content-type": "application/json",
            **self.auth_headers(route, key),
            **(route.headers or {}),
        }
        body_bytes = json.dumps({"model": route.model, "input": req.input}).encode("utf-8")
        fetch_fn = ctx.fetch if (ctx and ctx.fetch) else default_fetch
        timeout_ms = route.timeoutMs or 30000
        try:
            resp = await fetch_fn(url, headers, body_bytes, timeout_ms)
        except Exception as e:
            raise to_network_error(label, e)

        require_ok(resp.status, resp.headers, resp.body_text, label)
        j = json.loads(resp.body_text)
        data_raw = j.get("data", []) if isinstance(j.get("data"), list) else []
        data = [
            EmbeddingData(
                index=d.get("index", i),
                embedding=d.get("embedding", []),
            )
            for i, d in enumerate(data_raw)
        ]
        return EmbeddingResponse(
            object="list",
            model=j.get("model", route.model),
            provider=label,
            data=data,
            usage=to_usage(j.get("usage")),
        )
