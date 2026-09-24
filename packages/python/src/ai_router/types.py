"""Unified request/response types for ai-router.

The unified surface intentionally mirrors the OpenAI chat-completions shape
so that translation layers stay thin and the raw escape hatch stays natural.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

Role = Literal["system", "user", "assistant", "tool"]


@dataclass
class FunctionCall:
    name: str
    arguments: str

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "arguments": self.arguments}


@dataclass
class ToolCall:
    id: str
    type: Literal["function"] = "function"
    function: FunctionCall = field(default_factory=lambda: FunctionCall(name="", arguments=""))

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "type": self.type,
            "function": self.function.to_dict() if isinstance(self.function, FunctionCall) else self.function,
        }


@dataclass
class TextPart:
    type: Literal["text"] = "text"
    text: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {"type": self.type, "text": self.text}


@dataclass
class ImageUrlData:
    url: str
    detail: Literal["auto", "low", "high"] | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {"url": self.url}
        if self.detail is not None:
            res["detail"] = self.detail
        return res


@dataclass
class ImageUrlPart:
    type: Literal["image_url"] = "image_url"
    image_url: ImageUrlData = field(default_factory=lambda: ImageUrlData(url=""))

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "image_url": self.image_url.to_dict() if isinstance(self.image_url, ImageUrlData) else self.image_url,
        }


ContentPart = TextPart | ImageUrlPart | dict[str, Any]
ProviderOptions = dict[str, dict[str, Any]]


@dataclass
class ChatMessage:
    role: Role
    content: str | Sequence[ContentPart] | None = None
    name: str | None = None
    tool_calls: list[ToolCall] | None = None
    tool_call_id: str | None = None
    reasoning: str | None = None
    providerOptions: ProviderOptions | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.name is not None:
            res["name"] = self.name
        if self.tool_calls is not None:
            res["tool_calls"] = [tc.to_dict() if isinstance(tc, ToolCall) else tc for tc in self.tool_calls]
        if self.tool_call_id is not None:
            res["tool_call_id"] = self.tool_call_id
        if self.reasoning is not None:
            res["reasoning"] = self.reasoning
        if self.providerOptions is not None:
            res["providerOptions"] = self.providerOptions
        return res


@dataclass
class FunctionDefinition:
    name: str
    description: str | None = None
    parameters: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {"name": self.name, "parameters": self.parameters}
        if self.description is not None:
            res["description"] = self.description
        return res


@dataclass
class Tool:
    type: Literal["function"] = "function"
    function: FunctionDefinition | dict[str, Any] = field(
        default_factory=lambda: FunctionDefinition(name="", parameters={})
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "type": self.type,
            "function": self.function.to_dict() if isinstance(self.function, FunctionDefinition) else self.function,
        }


@dataclass
class JsonSchemaConfig:
    schema: dict[str, Any]
    name: str | None = None
    strict: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {"schema": self.schema}
        if self.name is not None:
            res["name"] = self.name
        if self.strict is not None:
            res["strict"] = self.strict
        return res


ResponseFormat = dict[str, Any] | Literal["text", "json_object"]


ToolChoice = Literal["none", "auto", "required"] | dict[str, Any]


@dataclass
class ChatRequest:
    model: str
    messages: list[ChatMessage]
    tools: list[Tool] | None = None
    tool_choice: ToolChoice | None = None
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    stop: str | list[str] | None = None
    response_format: ResponseFormat | None = None
    reasoning_effort: Literal["low", "medium", "high"] | None = None
    providerOptions: ProviderOptions | None = None
    user: str | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {
            "model": self.model,
            "messages": [m.to_dict() if isinstance(m, ChatMessage) else m for m in self.messages],
        }
        if self.tools is not None:
            res["tools"] = [t.to_dict() if isinstance(t, Tool) else t for t in self.tools]
        if self.tool_choice is not None:
            res["tool_choice"] = self.tool_choice
        if self.temperature is not None:
            res["temperature"] = self.temperature
        if self.top_p is not None:
            res["top_p"] = self.top_p
        if self.max_tokens is not None:
            res["max_tokens"] = self.max_tokens
        if self.stop is not None:
            res["stop"] = self.stop
        if self.response_format is not None:
            res["response_format"] = self.response_format
        if self.reasoning_effort is not None:
            res["reasoning_effort"] = self.reasoning_effort
        if self.providerOptions is not None:
            res["providerOptions"] = self.providerOptions
        if self.user is not None:
            res["user"] = self.user
        return res


@dataclass
class Usage:
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    cached_tokens: int | None = None
    cache_write_tokens: int | None = None
    reasoning_tokens: int | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
        }
        if self.cached_tokens is not None:
            res["cached_tokens"] = self.cached_tokens
        if self.cache_write_tokens is not None:
            res["cache_write_tokens"] = self.cache_write_tokens
        if self.reasoning_tokens is not None:
            res["reasoning_tokens"] = self.reasoning_tokens
        return res


@dataclass
class TokenPrice:
    input: float = 0.0
    output: float = 0.0
    cache_read: float | None = None
    cache_write: float | None = None
    input_usd: float = 0.0
    output_usd: float = 0.0
    cached_usd: float | None = None

    def __post_init__(self) -> None:
        if self.input_usd == 0.0 and self.input != 0.0:
            self.input_usd = self.input
        elif self.input == 0.0 and self.input_usd != 0.0:
            self.input = self.input_usd
        if self.output_usd == 0.0 and self.output != 0.0:
            self.output_usd = self.output
        elif self.output == 0.0 and self.output_usd != 0.0:
            self.output = self.output_usd
        if self.cached_usd is None and self.cache_read is not None:
            self.cached_usd = self.cache_read


@dataclass
class Choice:
    index: int = 0
    message: ChatMessage = field(default_factory=lambda: ChatMessage(role="assistant", content=None))
    finish_reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "message": self.message.to_dict() if isinstance(self.message, ChatMessage) else self.message,
            "finish_reason": self.finish_reason,
        }


@dataclass
class ChatResponse:
    id: str = ""
    model: str = ""
    provider: str = ""
    created: int = 0
    choices: list[Choice] = field(default_factory=list)
    usage: Usage | None = None
    cost_usd: float | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {
            "id": self.id,
            "model": self.model,
            "provider": self.provider,
            "created": self.created,
            "choices": [c.to_dict() if isinstance(c, Choice) else c for c in self.choices],
            "usage": self.usage.to_dict() if isinstance(self.usage, Usage) else self.usage,
        }
        if self.cost_usd is not None:
            res["cost_usd"] = self.cost_usd
        return res


@dataclass
class ToolCallDeltaFunction:
    name: str | None = None
    arguments: str | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {}
        if self.name is not None:
            res["name"] = self.name
        if self.arguments is not None:
            res["arguments"] = self.arguments
        return res


@dataclass
class ToolCallDelta:
    index: int = 0
    id: str | None = None
    type: Literal["function"] | None = None
    function: ToolCallDeltaFunction | dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {"index": self.index}
        if self.id is not None:
            res["id"] = self.id
        if self.type is not None:
            res["type"] = self.type
        if self.function is not None:
            res["function"] = (
                self.function.to_dict() if isinstance(self.function, ToolCallDeltaFunction) else self.function
            )
        return res


@dataclass
class Delta:
    role: Role | None = None
    content: str | None = None
    reasoning: str | None = None
    tool_calls: list[ToolCallDelta] | list[dict[str, Any]] | list[Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {}
        if self.role is not None:
            res["role"] = self.role
        if self.content is not None:
            res["content"] = self.content
        if self.reasoning is not None:
            res["reasoning"] = self.reasoning
        if self.tool_calls is not None:
            res["tool_calls"] = [tc.to_dict() if isinstance(tc, ToolCallDelta) else tc for tc in self.tool_calls]
        return res


@dataclass
class ChatChunk:
    id: str = ""
    model: str = ""
    provider: str = ""
    delta: Delta = field(default_factory=Delta)
    finish_reason: str | None = None
    usage: Usage | None = None
    cost_usd: float | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {
            "id": self.id,
            "model": self.model,
            "provider": self.provider,
            "delta": self.delta.to_dict() if isinstance(self.delta, Delta) else self.delta,
            "finish_reason": self.finish_reason,
        }
        if self.usage is not None:
            res["usage"] = self.usage.to_dict() if isinstance(self.usage, Usage) else self.usage
        if self.cost_usd is not None:
            res["cost_usd"] = self.cost_usd
        return res


# Embeddings


@dataclass
class EmbeddingRequest:
    model: str
    input: str | list[str]

    def to_dict(self) -> dict[str, Any]:
        return {"model": self.model, "input": self.input}


@dataclass
class EmbeddingData:
    index: int
    embedding: list[float]

    def to_dict(self) -> dict[str, Any]:
        return {"index": self.index, "embedding": self.embedding}


@dataclass
class EmbeddingResponse:
    object: Literal["list"]
    model: str
    provider: str
    data: list[EmbeddingData]
    usage: Usage | None = None
    cost_usd: float | None = None

    def to_dict(self) -> dict[str, Any]:
        res: dict[str, Any] = {
            "object": self.object,
            "model": self.model,
            "provider": self.provider,
            "data": [d.to_dict() if isinstance(d, EmbeddingData) else d for d in self.data],
            "usage": self.usage.to_dict() if isinstance(self.usage, Usage) else self.usage,
        }
        if self.cost_usd is not None:
            res["cost_usd"] = self.cost_usd
        return res
