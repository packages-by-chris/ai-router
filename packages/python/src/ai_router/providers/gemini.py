"""Google Gemini generateContent provider adapter."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
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
    EmbeddingData,
    EmbeddingRequest,
    EmbeddingResponse,
    FunctionCall,
    ToolCall,
    Usage,
)
from .types import AdapterContext, NormalizedRoute, ProviderAdapter, RawRequestOptions

GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

GEMINI_THINKING_BUDGETS: dict[str, int] = {
    "low": 1024,
    "medium": 8192,
    "high": 24576,
}


def base_url(route: NormalizedRoute) -> str:
    return (route.baseUrl or GEMINI_DEFAULT_BASE_URL).rstrip("/")


def map_finish_reason(finish_reason: Any) -> str | None:
    """Gemini finishReason -> OpenAI-style finish_reason."""
    if finish_reason == "STOP":
        return "stop"
    if finish_reason == "MAX_TOKENS":
        return "length"
    if finish_reason in ("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT"):
        return "content_filter"
    return str(finish_reason) if isinstance(finish_reason, str) else None


def _guess_image_mime(url: str) -> str:
    try:
        parsed = urllib.parse.urlparse(url)
        m = re.search(r"\.([a-z0-9]+)(?:[?#]|$)", parsed.path, re.IGNORECASE)
        ext = m.group(1).lower() if m else None
        if ext == "png":
            return "image/png"
        if ext == "webp":
            return "image/webp"
        if ext == "gif":
            return "image/gif"
        return "image/jpeg"
    except Exception:
        return "image/jpeg"


def _image_part(url: str) -> dict[str, Any] | None:
    data_uri = re.match(r"^data:([^;,]+);base64,(.*)$", url, re.IGNORECASE)
    if data_uri:
        return {"inlineData": {"mimeType": data_uri.group(1), "data": data_uri.group(2)}}
    if re.match(r"^https?://", url, re.IGNORECASE):
        return {"fileData": {"mimeType": _guess_image_mime(url), "fileUri": url}}
    return None


def _push_unified_content(push_fn: Any, role: str, content: Any) -> None:
    if isinstance(content, str):
        if len(content) > 0:
            push_fn(role, {"text": content})
        return
    if isinstance(content, list):
        for part in content:
            p_type = part.get("type") if isinstance(part, dict) else getattr(part, "type", None)
            if p_type == "text":
                text = part.get("text") if isinstance(part, dict) else getattr(part, "text", "")
                if text and len(text) > 0:
                    push_fn(role, {"text": text})
            elif p_type == "image_url":
                img_url_obj = part.get("image_url") if isinstance(part, dict) else getattr(part, "image_url", None)
                url = img_url_obj.get("url") if isinstance(img_url_obj, dict) else getattr(img_url_obj, "url", "")
                if url:
                    image = _image_part(url)
                    if image:
                        push_fn(role, image)


def translate_request(
    req: ChatRequest | dict[str, Any],
    provider_model: str,
    stream: bool,
) -> dict[str, Any]:
    """Unified ChatRequest -> Gemini generateContent wire format."""
    req_dict = req.to_dict() if isinstance(req, ChatRequest) else dict(req)
    messages = req_dict.get("messages", [])

    system_parts: list[str] = []
    call_names: dict[str, str] = {}
    for msg in messages:
        tcs = msg.get("tool_calls", []) if isinstance(msg, dict) else (getattr(msg, "tool_calls", None) or [])
        for tc in tcs:
            tc_dict = tc.to_dict() if hasattr(tc, "to_dict") else tc
            fn = tc_dict.get("function", {}) if isinstance(tc_dict, dict) else {}
            call_names[tc_dict.get("id", "")] = fn.get("name", "")

    turns: list[dict[str, Any]] = []

    def push(role: str, part: dict[str, Any]) -> None:
        if turns and turns[-1]["role"] == role:
            turns[-1]["parts"].append(part)
        else:
            turns.append({"role": role, "parts": [part]})

    for msg in messages:
        role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", None)
        content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)

        if role == "system":
            if isinstance(content, str):
                if len(content) > 0:
                    system_parts.append(content)
            elif isinstance(content, list):
                for part in content:
                    p_type = part.get("type") if isinstance(part, dict) else getattr(part, "type", None)
                    if p_type == "text":
                        text = part.get("text") if isinstance(part, dict) else getattr(part, "text", "")
                        if text and len(text) > 0:
                            system_parts.append(text)
            continue

        if role == "tool":
            tool_call_id = (
                msg.get("tool_call_id", "") if isinstance(msg, dict) else getattr(msg, "tool_call_id", "") or ""
            )
            name = (
                call_names.get(tool_call_id)
                or (msg.get("name") if isinstance(msg, dict) else getattr(msg, "name", ""))
                or ""
            )
            result_text = ""
            if isinstance(content, str):
                result_text = content
            elif isinstance(content, list):
                result_text = "\n".join(
                    p.get("text", "") if isinstance(p, dict) else getattr(p, "text", "")
                    for p in content
                    if (p.get("type") if isinstance(p, dict) else getattr(p, "type", None)) == "text"
                )
            fr_obj: dict[str, Any] = {
                "name": name,
                "response": {"result": result_text},
            }
            if tool_call_id:
                fr_obj["id"] = tool_call_id
            push("user", {"functionResponse": fr_obj})
            continue

        turn_role = "model" if role == "assistant" else "user"
        _push_unified_content(push, turn_role, content)

        tool_calls = msg.get("tool_calls", []) if isinstance(msg, dict) else (getattr(msg, "tool_calls", None) or [])
        for tc in tool_calls:
            tc_dict = tc.to_dict() if hasattr(tc, "to_dict") else tc
            fn = tc_dict.get("function", {}) if isinstance(tc_dict, dict) else {}
            args_str = fn.get("arguments", "{}") if isinstance(fn, dict) else "{}"
            try:
                args = json.loads(args_str or "{}")
            except Exception:
                args = {}
            fc_obj: dict[str, Any] = {
                "name": fn.get("name", ""),
                "args": args,
            }
            if tc_dict.get("id"):
                fc_obj["id"] = tc_dict["id"]
            push(turn_role, {"functionCall": fc_obj})

    body: dict[str, Any] = {
        "contents": turns,
    }

    if system_parts:
        body["systemInstruction"] = {"parts": [{"text": t} for t in system_parts]}

    generation_config: dict[str, Any] = {}
    if req_dict.get("temperature") is not None:
        generation_config["temperature"] = req_dict["temperature"]
    if req_dict.get("top_p") is not None:
        generation_config["topP"] = req_dict["top_p"]
    if req_dict.get("max_tokens") is not None:
        generation_config["maxOutputTokens"] = req_dict["max_tokens"]
    if req_dict.get("stop") is not None:
        stop = req_dict["stop"]
        generation_config["stopSequences"] = stop if isinstance(stop, list) else [stop]

    rf = req_dict.get("response_format")
    if isinstance(rf, dict):
        if rf.get("type") == "json_object":
            generation_config["responseMimeType"] = "application/json"
        elif rf.get("type") == "json_schema":
            generation_config["responseMimeType"] = "application/json"
            js = rf.get("json_schema", {})
            if isinstance(js, dict) and "schema" in js:
                generation_config["responseJsonSchema"] = js["schema"]
    elif rf == "json_object":
        generation_config["responseMimeType"] = "application/json"

    reasoning_effort = req_dict.get("reasoning_effort")
    if reasoning_effort is not None:
        generation_config["thinkingConfig"] = {
            "thinkingBudget": GEMINI_THINKING_BUDGETS.get(reasoning_effort, 8192),
            "includeThoughts": True,
        }

    if generation_config:
        body["generationConfig"] = generation_config

    tools = req_dict.get("tools")
    tool_choice = req_dict.get("tool_choice")
    if tool_choice != "none" and tools and len(tools) > 0:
        decls: list[dict[str, Any]] = []
        for t in tools:
            t_dict = t.to_dict() if hasattr(t, "to_dict") else t
            fn = t_dict.get("function", {}) if isinstance(t_dict, dict) else {}
            item: dict[str, Any] = {
                "name": fn.get("name", ""),
                "parameters": fn.get("parameters", {}),
            }
            if "description" in fn and fn["description"] is not None:
                item["description"] = fn["description"]
            decls.append(item)
        body["tools"] = [{"functionDeclarations": decls}]

        if tool_choice == "auto":
            body["toolConfig"] = {"functionCallingConfig": {"mode": "AUTO"}}
        elif tool_choice == "required":
            body["toolConfig"] = {"functionCallingConfig": {"mode": "ANY"}}
        elif isinstance(tool_choice, dict):
            fn_obj = tool_choice.get("function", {})
            name = fn_obj.get("name") if isinstance(fn_obj, dict) else ""
            if name:
                body["toolConfig"] = {
                    "functionCallingConfig": {
                        "mode": "ANY",
                        "allowedFunctionNames": [name],
                    }
                }

    opts = req_dict.get("providerOptions")
    if isinstance(opts, dict):
        extra = opts.get("gemini")
        if isinstance(extra, dict):
            body.update(extra)

    return body


def _to_usage(v: Any) -> Usage | None:
    if not isinstance(v, dict):
        return None
    prompt = v.get("promptTokenCount")
    comp = v.get("candidatesTokenCount")
    if not isinstance(prompt, int) or not isinstance(comp, int):
        return None
    total = v.get("totalTokenCount")
    if not isinstance(total, int):
        total = prompt + comp
    cached = v.get("cachedContentTokenCount")
    thoughts = v.get("thoughtsTokenCount")
    return Usage(
        prompt_tokens=prompt,
        completion_tokens=comp,
        total_tokens=total,
        cached_tokens=cached if isinstance(cached, int) and cached > 0 else None,
        reasoning_tokens=thoughts if isinstance(thoughts, int) and thoughts > 0 else None,
    )


def _parts_to_unified(parts: list[dict[str, Any]]) -> tuple[str, str, list[ToolCall]]:
    text = ""
    reasoning = ""
    tool_calls: list[ToolCall] = []

    for part in parts:
        if not isinstance(part, dict):
            continue
        p_text = part.get("text")
        if isinstance(p_text, str):
            if part.get("thought") is True:
                reasoning += p_text
            else:
                text += p_text
        fc = part.get("functionCall")
        if isinstance(fc, dict):
            idx = len(tool_calls)
            cid = fc.get("id") or f"call_{idx}"
            tool_calls.append(
                ToolCall(
                    id=cid,
                    type="function",
                    function=FunctionCall(
                        name=fc.get("name", ""),
                        arguments=json.dumps(fc.get("args", {}), separators=(",", ":")),
                    ),
                )
            )

    return text, reasoning, tool_calls


def translate_response(json_data: Any, provider_model: str) -> ChatResponse:
    """Gemini generateContent response -> unified ChatResponse."""
    j = json_data if isinstance(json_data, dict) else {}
    candidates = j.get("candidates", []) if isinstance(j.get("candidates"), list) else []
    candidate = candidates[0] if candidates and isinstance(candidates[0], dict) else None
    prompt_feedback = j.get("promptFeedback")
    blocked = isinstance(prompt_feedback, dict) and isinstance(prompt_feedback.get("blockReason"), str)

    text = ""
    reasoning = ""
    tool_calls: list[ToolCall] = []
    finish: str | None = None

    if candidate:
        content = candidate.get("content", {})
        parts = content.get("parts", []) if isinstance(content.get("parts"), list) else []
        text, reasoning, tool_calls = _parts_to_unified(parts)
        finish = map_finish_reason(candidate.get("finishReason"))
    elif blocked:
        finish = "content_filter"

    msg = ChatMessage(
        role="assistant",
        content=text if text != "" else (None if len(tool_calls) > 0 else ""),
        reasoning=reasoning if reasoning != "" else None,
        tool_calls=tool_calls if len(tool_calls) > 0 else None,
    )

    return ChatResponse(
        id=j.get("responseId", "") if isinstance(j.get("responseId"), str) else "",
        model=j.get("modelVersion", provider_model) if isinstance(j.get("modelVersion"), str) else provider_model,
        provider="gemini",
        created=0,
        usage=_to_usage(j.get("usageMetadata")),
        choices=[
            Choice(
                index=0,
                finish_reason=finish,
                message=msg,
            )
        ],
    )


def _classify_stream_error(status: Any) -> ErrorKind:
    if status == "INVALID_ARGUMENT":
        return "invalid_request"
    if status == "UNAUTHENTICATED":
        return "auth"
    if status == "PERMISSION_DENIED":
        return "permission"
    if status == "NOT_FOUND":
        return "not_found"
    if status == "RESOURCE_EXHAUSTED":
        return "rate_limit"
    if status in ("INTERNAL", "UNAVAILABLE"):
        return "server"
    return "unknown"


class GeminiAdapter(ProviderAdapter):
    @property
    def id(self) -> str:
        return "gemini"

    def headers(self, route: NormalizedRoute, key: str) -> dict[str, str]:
        return {
            "content-type": "application/json",
            "x-goog-api-key": key,
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

        url = f"{base_url(route)}/models/{urllib.parse.quote(route.model)}:generateContent"
        headers = self.headers(route, key)
        body_bytes = json.dumps(translate_request(req, route.model, False)).encode("utf-8")
        fetch_fn = ctx.fetch if (ctx and ctx.fetch) else default_fetch
        timeout_ms = route.timeoutMs or 30000
        try:
            resp = await fetch_fn(url, headers, body_bytes, timeout_ms)
        except Exception as e:
            raise to_network_error("gemini", e)

        require_ok(resp.status, resp.headers, resp.body_text, "gemini")
        return translate_response(json.loads(resp.body_text), route.model)

    async def stream(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> AsyncIterable[ChatChunk]:
        url = f"{base_url(route)}/models/{urllib.parse.quote(route.model)}:streamGenerateContent?alt=sse"
        headers = self.headers(route, key)
        body_bytes = json.dumps(translate_request(req, route.model, True)).encode("utf-8")
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")

        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            resp = urllib.request.urlopen(req_obj, timeout=timeout_sec)
            require_ok(resp.status, dict(resp.headers), None, "gemini")
        except urllib.error.HTTPError as e:
            require_ok(e.code, dict(e.headers), e.read().decode("utf-8", errors="replace"), "gemini")
            raise
        except Exception as e:
            raise to_network_error("gemini", e)

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
                    raise ProviderError("gemini", kind, f"gemini: {msg}", body=ev)

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
                                provider="gemini",
                                delta=Delta(role="assistant"),
                                finish_reason=None,
                            )
                        p_text = part.get("text")
                        if isinstance(p_text, str) and p_text != "":
                            if part.get("thought") is True:
                                yield ChatChunk(
                                    id="",
                                    model=served_model,
                                    provider="gemini",
                                    delta=Delta(reasoning=p_text),
                                    finish_reason=None,
                                )
                            else:
                                yield ChatChunk(
                                    id="",
                                    model=served_model,
                                    provider="gemini",
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
                                provider="gemini",
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
                    id="",
                    model=served_model,
                    provider="gemini",
                    delta=Delta(),
                    finish_reason=finish,
                    usage=usage,
                )

        return stream_generator()

    async def raw(
        self,
        route: NormalizedRoute,
        key: str,
        opts: RawRequestOptions,
        ctx: AdapterContext | None = None,
    ) -> Any:
        default_path = f"/models/{urllib.parse.quote(route.model)}:generateContent"
        url = f"{base_url(route)}{opts.path or default_path}"
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
            raise to_network_error("gemini", e)

    async def embed(
        self,
        route: NormalizedRoute,
        key: str,
        req: EmbeddingRequest,
        ctx: AdapterContext | None = None,
    ) -> EmbeddingResponse:
        from ..http.request import default_fetch

        inputs = req.input if isinstance(req.input, list) else [req.input]
        url = f"{base_url(route)}/models/{urllib.parse.quote(route.model)}:batchEmbedContents"
        headers = self.headers(route, key)
        body_bytes = json.dumps(
            {
                "requests": [
                    {"model": f"models/{route.model}", "content": {"parts": [{"text": text}]}} for text in inputs
                ]
            }
        ).encode("utf-8")
        fetch_fn = ctx.fetch if (ctx and ctx.fetch) else default_fetch
        timeout_ms = route.timeoutMs or 30000
        try:
            resp = await fetch_fn(url, headers, body_bytes, timeout_ms)
        except Exception as e:
            raise to_network_error("gemini", e)

        require_ok(resp.status, resp.headers, resp.body_text, "gemini")
        j = json.loads(resp.body_text)
        raw = j.get("embeddings", []) if isinstance(j.get("embeddings"), list) else []
        data = [
            EmbeddingData(
                index=i,
                embedding=d.get("values", []) if isinstance(d, dict) else [],
            )
            for i, d in enumerate(raw)
        ]
        return EmbeddingResponse(
            object="list",
            model=route.model,
            provider="gemini",
            data=data,
            usage=_to_usage(j.get("usageMetadata")),
        )
