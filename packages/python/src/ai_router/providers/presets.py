"""Provider presets: the "100+ providers" mechanism.

Most LLM vendors serve an OpenAI-compatible chat-completions API. A preset is DATA,
not code: provider: "groq" in a route expands to the right adapter + baseUrl at
routing time.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

PresetAuth = Literal["bearer", "none"] | dict[str, str]  # {"header": "X-Custom-Key"}


@dataclass
class ProviderPreset:
    adapter: str
    baseUrl: str
    auth: PresetAuth = "bearer"
    headers: dict[str, str] | None = None


PROVIDER_PRESETS: dict[str, ProviderPreset] = {
    "groq": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.groq.com/openai/v1",
    ),
    "deepseek": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.deepseek.com/v1",
    ),
    "mistral": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.mistral.ai/v1",
    ),
    "openrouter": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://openrouter.ai/api/v1",
    ),
    "together": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.together.xyz/v1",
    ),
    "fireworks": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.fireworks.ai/inference/v1",
    ),
    "perplexity": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.perplexity.ai",
    ),
    "xai": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.x.ai/v1",
    ),
    "cerebras": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.cerebras.ai/v1",
    ),
    "sambanova": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.sambanova.ai/v1",
    ),
    "cohere": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.cohere.ai/compatibility/v1",
    ),
    "deepinfra": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.deepinfra.com/v1/openai",
    ),
    "nvidia": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://integrate.api.nvidia.com/v1",
    ),
    "github-models": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://models.github.ai/inference",
    ),
    "hyperbolic": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.hyperbolic.xyz/v1",
    ),
    "novita": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.novita.ai/v3/openai",
    ),
    "nebius": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.studio.nebius.com/v1",
    ),
    "lambda": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.lambda.ai/v1",
    ),
    "moonshot": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.moonshot.cn/v1",
    ),
    "zhipu": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://open.bigmodel.cn/api/paas/v4",
    ),
    "yi": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.lingyiwanwu.com/v1",
    ),
    "stepfun": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.stepfun.com/v1",
    ),
    "upstage": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.upstage.ai/v1/solar",
    ),
    "ai21": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.ai21.com/studio/v1",
    ),
    "huggingface": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://router.huggingface.co/v1",
    ),
    "scaleway": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.scaleway.ai/v1",
    ),
    "ovhcloud": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
    ),
    "hunyuan": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.hunyuan.cloud.tencent.com/v1",
    ),
    "friendliai": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://inference.friendli.ai/v1",
    ),
    "kluster": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="https://api.kluster.ai/v1",
    ),
    "ollama": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="http://localhost:11434/v1",
        auth="none",
    ),
    "lmstudio": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="http://localhost:1234/v1",
        auth="none",
    ),
    "vllm": ProviderPreset(
        adapter="openai-compatible",
        baseUrl="http://localhost:8000/v1",
        auth="none",
    ),
}


def get_preset(id: str) -> ProviderPreset | None:
    return PROVIDER_PRESETS.get(id)
