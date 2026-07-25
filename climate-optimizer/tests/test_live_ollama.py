"""Live-Ollama integration test (spec 12 §LLM planning) — the one test that hits a real model.

Every other optimizer test injects a fake chain (spec 12 §Testing) so the suite is deterministic,
network-free, and safe to run anywhere. This module is the deliberate exception: it drives one full
planning cycle through the real ``planner.chain.build_chain`` against a live Ollama server, so a
change to the chain wiring, the prompt template, or the ``.with_structured_output`` boundary is
exercised against actual model output at least once — not just the fakes.

**Opt-in only.** Skipped unless ``RUN_LIVE_OLLAMA_TESTS=1`` is set, so the default `uv run pytest`
gate stays fast, deterministic, and network-free (CI has no Ollama; this is a local, manual check).
Override the target with ``OPTIMIZER_TEST_OLLAMA_ENDPOINT`` / ``OPTIMIZER_TEST_OLLAMA_MODEL``
(defaults: ``http://localhost:11434`` / ``llama3.2``, the host-mode default from ``deploy/.env``).

    RUN_LIVE_OLLAMA_TESTS=1 uv run pytest tests/test_live_ollama.py -v
"""

from __future__ import annotations

import os
from datetime import UTC, datetime

import httpx
import pytest

from climate_optimizer.config import Settings
from climate_optimizer.domain.twin import default_twin_params
from climate_optimizer.infra import schema_validation
from climate_optimizer.models import OutcomeStatus, Provider, ReasonCode
from climate_optimizer.orchestration.cycle import plan_record_payload, run_cycle
from climate_optimizer.orchestration.runtime import RuntimeState
from climate_optimizer.orchestration.store import ServiceStore
from climate_optimizer.planner import Planner
from climate_optimizer.planner.chain import build_chain
from conftest import StubPlatformClient

ENDPOINT = os.environ.get("OPTIMIZER_TEST_OLLAMA_ENDPOINT", "http://localhost:11434")
MODEL = os.environ.get("OPTIMIZER_TEST_OLLAMA_MODEL", "llama3.2")
NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)

# A CPU-bound model can run well past the 90 s production cycle_timeout_seconds (P3-PERF-2); this test
# is checking chain wiring, not enforcing that budget, so it gets a generous allowance instead of
# reporting a spurious CYCLE_TIMEOUT.
_TEST_CYCLE_TIMEOUT_SECONDS = 300.0


def _opted_in() -> bool:
    return os.environ.get("RUN_LIVE_OLLAMA_TESTS") == "1"


def _model_available() -> bool:
    """Best-effort reachability + model-pulled check, used only to shape the skip reason."""
    try:
        resp = httpx.get(f"{ENDPOINT}/api/tags", timeout=2.0)
        resp.raise_for_status()
    except Exception:  # noqa: BLE001 — any failure here just means "not available"
        return False
    names = {m.get("name", "") for m in resp.json().get("models", [])}
    return MODEL in names or f"{MODEL}:latest" in names


pytestmark = pytest.mark.skipif(
    not _opted_in(),
    reason="opt-in only: set RUN_LIVE_OLLAMA_TESTS=1 to run against a live Ollama server",
)


async def test_a_real_ollama_cycle_produces_a_contract_valid_plan() -> None:
    """One live planning cycle against Ollama — proves the chain wiring against real model output."""
    if not _model_available():
        pytest.skip(f"ollama unreachable or {MODEL!r} not pulled at {ENDPOINT}")

    settings = Settings(
        llm={"provider": "ollama", "endpoint": ENDPOINT, "model": MODEL},
        service={"cycle_timeout_seconds": _TEST_CYCLE_TIMEOUT_SECONDS},
    )
    record = await run_cycle(
        "gh-a",
        settings=settings,
        client=StubPlatformClient(settings),
        planner=Planner(settings, chain_factory=lambda model: build_chain(settings, model=model)),
        runtime=RuntimeState(settings),
        store=ServiceStore(),
        params=default_twin_params(),
        now=NOW,
    )

    # Contract-valid regardless of outcome — the schema is the boundary a real model must clear.
    schema_validation.validate_plan_record(plan_record_payload(record))
    assert record.backend.provider is Provider.OLLAMA
    assert record.backend.model == MODEL

    # A healthy, gate-passing context with no prior cycle memory means the state-change gate has
    # nothing to suppress against, so the LLM is always invoked. A small local model does not always
    # return a schema-valid structured output, though (e.g. an empty ``{}`` patch on one trajectory
    # point) — that is a legitimate ``LLM_UNAVAILABLE`` escalation with ``plan: None``, proving the
    # pipeline correctly rejects malformed model output, not a pipeline bug. Any *other* plan-less
    # reason (a gate hold, a twin fault, a timeout) would mean something upstream broke.
    if record.plan is None:
        assert record.outcome.reason_code is ReasonCode.LLM_UNAVAILABLE, record.outcome
    else:
        assert record.outcome.status in (OutcomeStatus.APPLIED, OutcomeStatus.ESCALATED)
