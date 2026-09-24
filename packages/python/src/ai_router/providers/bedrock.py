"""AWS Bedrock Converse API provider adapter."""

from __future__ import annotations

import datetime
import hashlib
import hmac
import json
import re
import struct
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import AsyncIterable
from dataclasses import dataclass
from typing import Any

from ..errors import ConfigError, ErrorKind, ProviderError
from ..http.request import require_ok, to_network_error
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


@dataclass
class AwsCredentials:
    access_key_id: str
    secret_access_key: str
    session_token: str | None = None


def parse_aws_credentials(key: str) -> AwsCredentials:
    parts = key.split(":")
    if len(parts) < 2 or not parts[0] or not parts[1]:
        raise ConfigError('route: bedrock apiKey must be "ACCESS_KEY_ID:SECRET_ACCESS_KEY[:SESSION_TOKEN]"')
    return AwsCredentials(
        access_key_id=parts[0],
        secret_access_key=parts[1],
        session_token=parts[2] if len(parts) > 2 and parts[2] else None,
    )


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac_sha256(key: bytes, msg: bytes) -> bytes:
    return hmac.new(key, msg, hashlib.sha256).digest()


def _amz_date(now: datetime.datetime | None = None) -> tuple[str, str]:
    dt = now or datetime.datetime.now(datetime.timezone.utc)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=datetime.timezone.utc)
    else:
        dt = dt.astimezone(datetime.timezone.utc)
    amz = dt.strftime("%Y%m%dT%H%M%SZ")
    date = dt.strftime("%Y%m%d")
    return amz, date


def sigv4_headers(
    method: str,
    url: str,
    body: bytes,
    credentials: AwsCredentials,
    region: str,
    service: str = "bedrock",
    now: datetime.datetime | None = None,
) -> dict[str, str]:
    """Generates AWS SigV4 signed headers for a request."""
    parsed_url = urllib.parse.urlparse(url)
    amz, date = _amz_date(now)

    uri = "/".join(urllib.parse.quote(seg, safe="") for seg in parsed_url.path.split("/"))
    canonical_headers = f"content-type:application/json\nhost:{parsed_url.netloc}\nx-amz-date:{amz}\n" + (
        f"x-amz-security-token:{credentials.session_token}\n" if credentials.session_token else ""
    )
    signed_headers = "content-type;host;x-amz-date" + (";x-amz-security-token" if credentials.session_token else "")

    payload_hash = _sha256_hex(body)
    canonical_request = "\n".join(
        [
            method,
            uri,
            "",  # no query params
            canonical_headers,
            signed_headers,
            payload_hash,
        ]
    )

    scope = f"{date}/{region}/{service}/aws4_request"
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz,
            scope,
            _sha256_hex(canonical_request.encode("utf-8")),
        ]
    )

    k_date = _hmac_sha256(f"AWS4{credentials.secret_access_key}".encode(), date.encode("utf-8"))
    k_region = _hmac_sha256(k_date, region.encode("utf-8"))
    k_service = _hmac_sha256(k_region, service.encode("utf-8"))
    k_signing = _hmac_sha256(k_service, b"aws4_request")

    signature = _hmac_sha256(k_signing, string_to_sign.encode("utf-8")).hex()

    headers = {
        "content-type": "application/json",
        "x-amz-date": amz,
        "authorization": (
            f"AWS4-HMAC-SHA256 Credential={credentials.access_key_id}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }
    if credentials.session_token:
        headers["x-amz-security-token"] = credentials.session_token
    return headers


@dataclass
class AwsEventStreamMessage:
    headers: dict[str, str]
    payload: bytes


def _parse_event_stream_headers(data: bytes, start: int, end: int) -> dict[str, str]:
    headers: dict[str, str] = {}
    off = start
    while off < end:
        name_len = data[off]
        off += 1
        name = data[off : off + name_len].decode("utf-8", errors="replace")
        off += name_len
        val_type = data[off]
        off += 1
        if val_type == 7 or val_type == 6:
            str_len = struct.unpack_from(">H", data, off)[0]
            val_bytes = data[off + 2 : off + 2 + str_len]
            headers[name] = val_bytes.decode("utf-8", errors="replace") if val_type == 7 else f"<binary:{str_len}>"
            off += 2 + str_len
        elif val_type in (0, 1):
            off += 0
        elif val_type == 2:
            off += 1
        elif val_type == 3 or val_type == 10:
            off += 2
        elif val_type == 4 or val_type == 11:
            off += 4
        elif val_type in (5, 8, 9, 12):
            off += 8
        elif val_type == 13:
            while off < end and (data[off] & 0x80) != 0:
                off += 1
            off += 1
        else:
            break
    return headers


async def aws_event_stream(stream: AsyncIterable[bytes]) -> AsyncIterable[AwsEventStreamMessage]:
    """Incremental parser for AWS event-stream binary framing."""
    buffer = bytearray()
    async for chunk in stream:
        if not chunk:
            continue
        buffer.extend(chunk)

        while len(buffer) >= 12:
            total_len, headers_len, _ = struct.unpack_from(">III", buffer, 0)
            if len(buffer) < total_len:
                break
            headers_end = 12 + headers_len
            payload_end = total_len - 4
            headers = _parse_event_stream_headers(bytes(buffer), 12, headers_end) if headers_end <= payload_end else {}
            payload = bytes(buffer[12 + headers_len : payload_end])
            yield AwsEventStreamMessage(headers=headers, payload=payload)
            buffer = buffer[total_len:]


def base_url(route: NormalizedRoute) -> str:
    if route.baseUrl:
        return route.baseUrl.rstrip("/")
    if not route.region:
        raise ConfigError(f'route "{route.id}": bedrock provider requires region')
    return f"https://bedrock-runtime.{route.region}.amazonaws.com"


def map_bedrock_stop_reason(stop_reason: Any) -> str | None:
    """Converse stopReason -> OpenAI-style finish_reason."""
    if stop_reason in ("end_turn", "stop_sequence"):
        return "stop"
    if stop_reason == "max_tokens":
        return "length"
    if stop_reason == "tool_use":
        return "tool_calls"
    if stop_reason in ("content_filtered", "guardrail_intervened"):
        return "content_filter"
    return str(stop_reason) if isinstance(stop_reason, str) else None


IMAGE_FORMATS = {
    "image/png": "png",
    "image/jpeg": "jpeg",
    "image/gif": "gif",
    "image/webp": "webp",
}


def _image_block(url: str) -> dict[str, Any] | None:
    data_uri = re.match(r"^data:([^;,]+);base64,(.*)$", url, re.IGNORECASE)
    if not data_uri:
        return None
    fmt = IMAGE_FORMATS.get(data_uri.group(1).lower())
    if not fmt:
        return None
    return {"image": {"format": fmt, "source": {"bytes": data_uri.group(2)}}}


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
                    block = _image_block(url)
                    if block:
                        push_fn(role, block)


def translate_request(
    req: ChatRequest | dict[str, Any],
    provider_model: str,
    stream: bool,
) -> dict[str, Any]:
    """Unified ChatRequest -> Bedrock Converse API wire format."""
    req_dict = req.to_dict() if isinstance(req, ChatRequest) else dict(req)
    messages = req_dict.get("messages", [])

    system_parts: list[str] = []
    turns: list[dict[str, Any]] = []

    def push(role: str, block: dict[str, Any]) -> None:
        if turns and turns[-1]["role"] == role:
            turns[-1]["content"].append(block)
        else:
            turns.append({"role": role, "content": [block]})

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
                    "toolResult": {
                        "toolUseId": tool_call_id,
                        "content": [{"text": result_text}],
                    }
                },
            )
            continue

        turn_role = "assistant" if role == "assistant" else "user"
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
            push(
                turn_role,
                {
                    "toolUse": {
                        "toolUseId": tc_dict.get("id", ""),
                        "name": fn.get("name", "") if isinstance(fn, dict) else "",
                        "input": args,
                    }
                },
            )

    body: dict[str, Any] = {
        "messages": turns,
    }

    if system_parts:
        body["system"] = [{"text": "\n\n".join(system_parts)}]

    inference_config: dict[str, Any] = {}
    if req_dict.get("temperature") is not None:
        inference_config["temperature"] = req_dict["temperature"]
    if req_dict.get("top_p") is not None:
        inference_config["topP"] = req_dict["top_p"]
    if req_dict.get("max_tokens") is not None:
        inference_config["maxTokens"] = req_dict["max_tokens"]
    if req_dict.get("stop") is not None:
        stop = req_dict["stop"]
        inference_config["stopSequences"] = stop if isinstance(stop, list) else [stop]

    if inference_config:
        body["inferenceConfig"] = inference_config

    tools = req_dict.get("tools")
    tool_choice = req_dict.get("tool_choice")
    if tool_choice != "none" and tools and len(tools) > 0:
        bedrock_tools: list[dict[str, Any]] = []
        for t in tools:
            t_dict = t.to_dict() if hasattr(t, "to_dict") else t
            fn = t_dict.get("function", {}) if isinstance(t_dict, dict) else {}
            spec: dict[str, Any] = {
                "name": fn.get("name", ""),
                "inputSchema": {"json": fn.get("parameters", {})},
            }
            if "description" in fn and fn["description"] is not None:
                spec["description"] = fn["description"]
            bedrock_tools.append({"toolSpec": spec})

        tool_config: dict[str, Any] = {"tools": bedrock_tools}
        if tool_choice == "auto":
            tool_config["toolChoice"] = {"auto": {}}
        elif tool_choice == "required":
            tool_config["toolChoice"] = {"any": {}}
        elif isinstance(tool_choice, dict):
            fn_obj = tool_choice.get("function", {})
            name = fn_obj.get("name") if isinstance(fn_obj, dict) else ""
            if name:
                tool_config["toolChoice"] = {"tool": {"name": name}}

        body["toolConfig"] = tool_config

    opts = req_dict.get("providerOptions")
    if isinstance(opts, dict):
        extra = opts.get("bedrock")
        if isinstance(extra, dict):
            body.update(extra)

    return body


def _to_usage(v: Any) -> Usage | None:
    if not isinstance(v, dict):
        return None
    inp = v.get("inputTokens")
    out = v.get("outputTokens")
    if not isinstance(inp, int) or not isinstance(out, int):
        return None
    total = v.get("totalTokens")
    if not isinstance(total, int):
        total = inp + out
    cache_read = v.get("cacheReadInputTokens") or 0
    cache_write = v.get("cacheWriteInputTokens") or 0
    return Usage(
        prompt_tokens=inp,
        completion_tokens=out,
        total_tokens=total,
        cached_tokens=cache_read if cache_read > 0 else None,
        cache_write_tokens=cache_write if cache_write > 0 else None,
    )


def translate_response(json_data: Any, provider_model: str) -> ChatResponse:
    """Bedrock Converse response -> unified ChatResponse."""
    j = json_data if isinstance(json_data, dict) else {}
    output = j.get("output", {}) if isinstance(j.get("output"), dict) else {}
    message = output.get("message", {}) if isinstance(output.get("message"), dict) else {}
    blocks = message.get("content", []) if isinstance(message.get("content"), list) else []

    text = ""
    reasoning = ""
    tool_calls: list[ToolCall] = []

    for block in blocks:
        if not isinstance(block, dict):
            continue
        p_text = block.get("text")
        if isinstance(p_text, str):
            text += p_text
        elif isinstance(block.get("reasoningContent"), dict):
            rc = block["reasoningContent"]
            if isinstance(rc.get("text"), str):
                reasoning += rc["text"]
        elif isinstance(block.get("toolUse"), dict):
            tu = block["toolUse"]
            tool_calls.append(
                ToolCall(
                    id=tu.get("toolUseId", ""),
                    type="function",
                    function=FunctionCall(
                        name=tu.get("name", ""),
                        arguments=json.dumps(tu.get("input", {}), separators=(",", ":")),
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
        id=j.get("messageId", "") if isinstance(j.get("messageId"), str) else "",
        model=provider_model,
        provider="bedrock",
        created=0,
        usage=_to_usage(j.get("usage")),
        choices=[
            Choice(
                index=0,
                finish_reason=map_bedrock_stop_reason(j.get("stopReason")),
                message=msg,
            )
        ],
    )


class BedrockAdapter(ProviderAdapter):
    @property
    def id(self) -> str:
        return "bedrock"

    def converse_url(self, route: NormalizedRoute, action: str) -> str:
        return f"{base_url(route)}/model/{urllib.parse.quote(route.model)}/{action}"

    async def complete(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> ChatResponse:
        if not route.region:
            raise ConfigError(f'route "{route.id}": bedrock provider requires region')
        url = self.converse_url(route, "converse")
        body_bytes = json.dumps(translate_request(req, route.model, False)).encode("utf-8")
        creds = parse_aws_credentials(key)
        headers = sigv4_headers("POST", url, body_bytes, creds, route.region)
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")

        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            with urllib.request.urlopen(req_obj, timeout=timeout_sec) as resp:
                status = resp.status
                resp_headers = dict(resp.headers)
                resp_text = resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            require_ok(e.code, dict(e.headers), e.read().decode("utf-8", errors="replace"), "bedrock")
            raise
        except Exception as e:
            raise to_network_error("bedrock", e)

        require_ok(status, resp_headers, resp_text, "bedrock")
        return translate_response(json.loads(resp_text), route.model)

    async def stream(
        self,
        route: NormalizedRoute,
        key: str,
        req: ChatRequest,
        ctx: AdapterContext | None = None,
    ) -> AsyncIterable[ChatChunk]:
        if not route.region:
            raise ConfigError(f'route "{route.id}": bedrock provider requires region')
        url = self.converse_url(route, "converse-stream")
        body_bytes = json.dumps(translate_request(req, route.model, True)).encode("utf-8")
        creds = parse_aws_credentials(key)
        headers = sigv4_headers("POST", url, body_bytes, creds, route.region)
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method="POST")

        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            resp = urllib.request.urlopen(req_obj, timeout=timeout_sec)
            require_ok(resp.status, dict(resp.headers), None, "bedrock")
        except urllib.error.HTTPError as e:
            require_ok(e.code, dict(e.headers), e.read().decode("utf-8", errors="replace"), "bedrock")
            raise
        except Exception as e:
            raise to_network_error("bedrock", e)

        async def stream_generator() -> AsyncIterable[ChatChunk]:
            served_model = route.model
            role_sent = False
            finish: str | None = None
            usage: Usage | None = None

            async def read_chunks() -> AsyncIterable[bytes]:
                try:
                    while True:
                        chunk = resp.read(1024)
                        if not chunk:
                            break
                        yield chunk
                finally:
                    resp.close()

            async for msg in aws_event_stream(read_chunks()):
                ev_type = msg.headers.get(":event-type")
                try:
                    ev = json.loads(msg.payload.decode("utf-8"))
                except Exception:
                    continue

                if ev_type == "contentBlockDelta":
                    delta = ev.get("delta", {})
                    idx = ev.get("contentBlockIndex", 0)
                    if delta.get("text"):
                        if not role_sent:
                            role_sent = True
                            yield ChatChunk(
                                id="",
                                model=served_model,
                                provider="bedrock",
                                delta=Delta(role="assistant"),
                                finish_reason=None,
                            )
                        yield ChatChunk(
                            id="",
                            model=served_model,
                            provider="bedrock",
                            delta=Delta(content=delta["text"]),
                            finish_reason=None,
                        )
                    elif isinstance(delta.get("reasoningContent"), dict) and delta["reasoningContent"].get("text"):
                        if not role_sent:
                            role_sent = True
                            yield ChatChunk(
                                id="",
                                model=served_model,
                                provider="bedrock",
                                delta=Delta(role="assistant"),
                                finish_reason=None,
                            )
                        yield ChatChunk(
                            id="",
                            model=served_model,
                            provider="bedrock",
                            delta=Delta(reasoning=delta["reasoningContent"]["text"]),
                            finish_reason=None,
                        )
                    elif isinstance(delta.get("toolUse"), dict) and delta["toolUse"].get("input"):
                        if not role_sent:
                            role_sent = True
                            yield ChatChunk(
                                id="",
                                model=served_model,
                                provider="bedrock",
                                delta=Delta(role="assistant"),
                                finish_reason=None,
                            )
                        yield ChatChunk(
                            id="",
                            model=served_model,
                            provider="bedrock",
                            delta=Delta(
                                tool_calls=[{"index": idx, "function": {"arguments": delta["toolUse"]["input"]}}]
                            ),
                            finish_reason=None,
                        )
                elif ev_type == "contentBlockStart":
                    start = ev.get("start", {})
                    if isinstance(start.get("toolUse"), dict):
                        tu = start["toolUse"]
                        idx = ev.get("contentBlockIndex", 0)
                        if not role_sent:
                            role_sent = True
                            yield ChatChunk(
                                id="",
                                model=served_model,
                                provider="bedrock",
                                delta=Delta(role="assistant"),
                                finish_reason=None,
                            )
                        d_tc = {
                            "index": idx,
                            "type": "function",
                            "function": {"name": tu.get("name", ""), "arguments": ""},
                        }
                        if tu.get("toolUseId"):
                            d_tc["id"] = tu["toolUseId"]
                        yield ChatChunk(
                            id="",
                            model=served_model,
                            provider="bedrock",
                            delta=Delta(tool_calls=[d_tc]),
                            finish_reason=None,
                        )
                elif ev_type == "messageStop":
                    finish = map_bedrock_stop_reason(ev.get("stopReason"))
                elif ev_type == "metadata":
                    meta = _to_usage(ev.get("usage"))
                    if meta:
                        usage = meta
                elif ev_type in (
                    "internalServerException",
                    "throttlingException",
                    "validationException",
                    "modelStreamErrorException",
                    "serviceUnavailableException",
                ):
                    kind: ErrorKind = "rate_limit" if ev_type == "throttlingException" else "server"
                    raise ProviderError("bedrock", kind, f"bedrock: {ev_type}", body=ev)

            if finish is not None or usage is not None:
                yield ChatChunk(
                    id="",
                    model=served_model,
                    provider="bedrock",
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
        if not route.region:
            raise ConfigError(f'route "{route.id}": bedrock provider requires region')
        default_path = f"/model/{urllib.parse.quote(route.model)}/converse"
        url = f"{base_url(route)}{opts.path or default_path}"
        body_bytes = (
            b"{}"
            if opts.body is None
            else (opts.body.encode("utf-8") if isinstance(opts.body, str) else json.dumps(opts.body).encode("utf-8"))
        )
        creds = parse_aws_credentials(key)
        headers = sigv4_headers(opts.method or "POST", url, body_bytes, creds, route.region)
        if opts.headers:
            headers.update(opts.headers)
        req_obj = urllib.request.Request(url, data=body_bytes, headers=headers, method=opts.method)
        timeout_sec = (route.timeoutMs or 30000) / 1000.0
        try:
            return urllib.request.urlopen(req_obj, timeout=timeout_sec)
        except Exception as e:
            raise to_network_error("bedrock", e)

    async def embed(
        self,
        route: NormalizedRoute,
        key: str,
        req: EmbeddingRequest,
        ctx: AdapterContext | None = None,
    ) -> EmbeddingResponse:
        raise ProviderError(self.id, "invalid_request", f"embeddings not supported by {self.id}")
