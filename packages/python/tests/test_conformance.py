"""Conformance tests verifying Python translations against the cross-SDK JSON fixtures."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ai_router.conformance.runner import run_translation_case

CASES_DIR = Path(__file__).resolve().parent.parent.parent / "core" / "conformance" / "cases"


def get_fixture_cases() -> list[tuple[str, dict]]:
    fixture_files = sorted(CASES_DIR.glob("*.json"))
    cases = []
    for f in fixture_files:
        with open(f, encoding="utf-8") as fp:
            data = json.load(fp)
            for c in data.get("cases", []):
                cases.append((f"{f.name} :: {c.get('name')}", c))
    return cases


@pytest.mark.asyncio
@pytest.mark.parametrize("case_id,case_dict", get_fixture_cases())
async def test_conformance_case(case_id: str, case_dict: dict) -> None:
    result = await run_translation_case(case_dict)
    if not result.ok:
        pytest.fail(f"Conformance failure for {case_id}\nExpected: {result.expected}\nActual:   {result.actual}")
