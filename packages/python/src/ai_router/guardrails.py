"""Guardrails: request/response validation and transformation hooks."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol, TypeVar, runtime_checkable

from .errors import GuardrailBlockedError
from .types import ChatRequest, ChatResponse

T = TypeVar("T")


@dataclass
class GuardrailVerdict:
    pass_: bool = True
    reason: str | None = None
    replace: Any = None


@runtime_checkable
class InputGuardrail(Protocol):
    @property
    def name(self) -> str | None: ...

    async def check(self, req: ChatRequest) -> GuardrailVerdict: ...


@runtime_checkable
class OutputGuardrail(Protocol):
    @property
    def name(self) -> str | None: ...

    async def check(self, res: ChatResponse) -> GuardrailVerdict: ...


@dataclass
class Guardrails:
    input: list[InputGuardrail] | None = None
    output: list[OutputGuardrail] | None = None


async def run_guardrails(
    phase: str,  # "input" | "output"
    guards: Sequence[Any] | None,
    value: T,
) -> T:
    """Run one guardrail phase. Returns the (possibly replaced) value; raises GuardrailBlockedError if blocked."""
    if not guards:
        return value

    import inspect

    current = value
    for i, guard in enumerate(guards):
        if hasattr(guard, "check"):
            res = guard.check(current)
            verdict = (await res) if inspect.isawaitable(res) else res
        elif callable(guard):
            res = guard(current)
            verdict = (await res) if inspect.isawaitable(res) else res
        else:
            continue

        if isinstance(verdict, dict):
            pass_val = verdict.get("pass", True)
            reason = verdict.get("reason")
            replace = verdict.get("replace")
        elif isinstance(verdict, GuardrailVerdict):
            pass_val = verdict.pass_
            reason = verdict.reason
            replace = verdict.replace
        else:
            pass_val = bool(verdict)
            reason = None
            replace = None

        if pass_val is False:
            name = getattr(guard, "name", None) or f"guardrails[{i}]"
            raise GuardrailBlockedError(phase=phase, guardrail=name, reason=reason)

        if replace is not None:
            current = replace

    return current
