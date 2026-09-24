import pytest

from ai_router.errors import GuardrailBlockedError
from ai_router.guardrails import (
    GuardrailVerdict,
    run_guardrails,
)
from ai_router.types import ChatMessage, ChatRequest, ChatResponse, Choice


class SecretKeywordGuard:
    name = "secret-keyword"

    async def check(self, req: ChatRequest) -> GuardrailVerdict:
        content = req.messages[0].content if req.messages else ""
        if isinstance(content, str) and "secret" in content.lower():
            return GuardrailVerdict(pass_=False, reason="contains secret keyword")
        return GuardrailVerdict(pass_=True)


class RedactionOutputGuard:
    name = "email-redactor"

    async def check(self, res: ChatResponse) -> GuardrailVerdict:
        content = res.choices[0].message.content if res.choices else ""
        if isinstance(content, str) and "@" in content:
            new_msg = ChatMessage(role="assistant", content="Contact me at [REDACTED] for info.")
            new_res = ChatResponse(
                id=res.id,
                model=res.model,
                choices=[Choice(index=0, message=new_msg)],
            )
            return GuardrailVerdict(pass_=True, replace=new_res)
        return GuardrailVerdict(pass_=True)


@pytest.mark.asyncio
async def test_input_guardrail_pass():
    req = ChatRequest(
        model="gpt-4o",
        messages=[ChatMessage(role="user", content="Hello world!")],
    )
    res = await run_guardrails("input", [SecretKeywordGuard()], req)
    assert res.messages[0].content == "Hello world!"


@pytest.mark.asyncio
async def test_input_guardrail_blocked():
    req = ChatRequest(
        model="gpt-4o",
        messages=[ChatMessage(role="user", content="Here is my secret password")],
    )
    with pytest.raises(GuardrailBlockedError) as exc_info:
        await run_guardrails("input", [SecretKeywordGuard()], req)
    assert "secret" in str(exc_info.value).lower()
    assert exc_info.value.phase == "input"
    assert exc_info.value.guardrail == "secret-keyword"


@pytest.mark.asyncio
async def test_output_guardrail_replacement():
    resp = ChatResponse(
        id="resp-1",
        model="gpt-4o",
        choices=[
            Choice(
                index=0,
                message=ChatMessage(
                    role="assistant",
                    content="Contact me at test@example.com for info.",
                ),
            )
        ],
    )
    processed = await run_guardrails("output", [RedactionOutputGuard()], resp)
    assert processed.choices[0].message.content == "Contact me at [REDACTED] for info."
