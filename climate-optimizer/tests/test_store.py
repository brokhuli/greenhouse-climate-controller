"""In-memory service state — escalation lifecycle, dedup, sweep, and the fleet rollup."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from uuid import uuid4

from climate_optimizer.models import (
    Backend,
    BackendRole,
    Horizon,
    Outcome,
    OutcomeStatus,
    PlanRecord,
    Provider,
    ReasonClass,
    ReasonCode,
)
from climate_optimizer.store import (
    Escalation,
    EscalationRegistry,
    PlanStore,
    Resolution,
    ServiceStore,
)
from conftest import build_plan

NOW = datetime(2026, 6, 17, 12, 0, tzinfo=UTC)
DEDUP = timedelta(minutes=60)
TTL = timedelta(minutes=1440)
RETENTION = timedelta(minutes=1440)


def _record(
    greenhouse_id: str = "gh-a",
    *,
    status: OutcomeStatus = OutcomeStatus.APPLIED,
    reason_code: ReasonCode | None = None,
    created_at: datetime = NOW,
) -> PlanRecord:
    return PlanRecord(
        schema_version=1,
        optimizer_run_id=uuid4(),
        greenhouse_id=greenhouse_id,
        created_at=created_at,
        horizon=Horizon(start=created_at, end=created_at + timedelta(hours=12)),
        backend=Backend(
            provider=Provider.OLLAMA,
            model="qwen2.5:7b",
            prompt_version="v1",
            role=BackendRole.PRIMARY,
        ),
        plan=build_plan() if status is OutcomeStatus.APPLIED else None,
        outcome=Outcome(status=status, reason_code=reason_code),
    )


def _raise(
    registry: EscalationRegistry,
    *,
    greenhouse_id: str = "gh-a",
    reason_code: ReasonCode = ReasonCode.INPUT_STALE,
    now: datetime = NOW,
) -> Escalation:
    return registry.raise_escalation(
        greenhouse_id=greenhouse_id,
        reason_code=reason_code,
        optimizer_run_id=uuid4(),
        message="held",
        now=now,
        dedup_window=DEDUP,
    )


def test_raising_opens_one_escalation() -> None:
    registry = EscalationRegistry()
    escalation = _raise(registry)

    assert escalation.is_open
    assert escalation.reason_class is ReasonClass.TRANSIENT
    assert registry.backlog() == 1


def test_identical_recurrence_folds_into_the_standing_entry() -> None:
    registry = EscalationRegistry()
    first = _raise(registry)
    second = _raise(registry, now=NOW + timedelta(minutes=30))

    # A recurring identical fault never supersedes itself (spec 09).
    assert second.escalation_id == first.escalation_id
    assert second.recurrence_count == 2
    assert second.last_seen_at == NOW + timedelta(minutes=30)
    assert registry.backlog() == 1


def test_a_different_reason_opens_a_second_escalation() -> None:
    registry = EscalationRegistry()
    _raise(registry, reason_code=ReasonCode.INPUT_STALE)
    _raise(registry, reason_code=ReasonCode.SENSOR_FAULT)
    assert registry.backlog() == 2


def test_escalations_are_scoped_per_greenhouse() -> None:
    registry = EscalationRegistry()
    _raise(registry, greenhouse_id="gh-a")
    _raise(registry, greenhouse_id="gh-b")
    assert registry.backlog() == 2
    assert len(registry.open_for_greenhouse("gh-a")) == 1


def test_a_fresh_outcome_supersedes_open_holds() -> None:
    registry = EscalationRegistry()
    escalation = _raise(registry)
    closed = registry.supersede("gh-a", now=NOW + timedelta(minutes=30))

    assert closed == 1
    assert escalation.resolution is Resolution.SUPERSEDED
    assert registry.backlog() == 0


def test_supersede_spares_the_reason_the_new_cycle_itself_raised() -> None:
    registry = EscalationRegistry()
    stale = _raise(registry, reason_code=ReasonCode.INPUT_STALE)
    fault = _raise(registry, reason_code=ReasonCode.SENSOR_FAULT)

    registry.supersede("gh-a", now=NOW, except_reason=ReasonCode.INPUT_STALE)

    assert stale.is_open
    assert fault.resolution is Resolution.SUPERSEDED


def test_ttl_expiry_closes_a_greenhouse_that_went_quiet() -> None:
    registry = EscalationRegistry()
    escalation = _raise(registry)

    assert registry.expire(NOW + timedelta(minutes=30), TTL) == 0
    assert registry.expire(NOW + TTL + timedelta(minutes=1), TTL) == 1
    assert escalation.resolution is Resolution.EXPIRED


def test_operator_resolution_closes_and_records_the_actor() -> None:
    registry = EscalationRegistry()
    escalation = _raise(registry)

    resolved = registry.resolve(escalation.escalation_id, now=NOW, actor="alice")

    assert resolved is not None
    assert resolved.resolution is Resolution.OPERATOR
    assert resolved.resolved_by == "alice"
    assert registry.backlog() == 0


def test_resolving_an_unknown_or_closed_escalation_returns_none() -> None:
    registry = EscalationRegistry()
    assert registry.resolve(uuid4(), now=NOW) is None

    escalation = _raise(registry)
    registry.resolve(escalation.escalation_id, now=NOW)
    assert registry.resolve(escalation.escalation_id, now=NOW) is None


def test_prune_drops_closed_escalations_past_retention() -> None:
    registry = EscalationRegistry()
    escalation = _raise(registry)
    registry.resolve(escalation.escalation_id, now=NOW)

    assert registry.prune(NOW + timedelta(minutes=10), RETENTION) == 0
    assert registry.prune(NOW + RETENTION + timedelta(minutes=1), RETENTION) == 1
    assert registry.get(escalation.escalation_id) is None


def test_open_set_is_triage_ordered_persistent_first() -> None:
    registry = EscalationRegistry()
    _raise(registry, reason_code=ReasonCode.INPUT_STALE, now=NOW)
    _raise(registry, reason_code=ReasonCode.CONTRACT_DRIFT, now=NOW + timedelta(minutes=5))

    order = [item.reason_code for item in registry.open_escalations()]
    # Persistent codes need an operator fix and will not self-heal, so they sort first.
    assert order == [ReasonCode.CONTRACT_DRIFT, ReasonCode.INPUT_STALE]


def test_oldest_open_age_tracks_the_longest_standing_hold() -> None:
    registry = EscalationRegistry()
    _raise(registry, reason_code=ReasonCode.INPUT_STALE, now=NOW)
    _raise(registry, reason_code=ReasonCode.SENSOR_FAULT, now=NOW + timedelta(minutes=10))

    assert registry.oldest_open_age_seconds(NOW + timedelta(minutes=20)) == 1200.0


def test_plan_store_keeps_latest_per_greenhouse() -> None:
    store = PlanStore()
    first = _record("gh-a")
    second = _record("gh-a")
    store.record(first)
    store.record(second)
    store.record(_record("gh-b"))

    assert store.latest("gh-a") is second
    assert set(store.all_latest()) == {"gh-a", "gh-b"}
    assert len(store.history("gh-a")) == 2


def test_plan_store_prune_always_keeps_the_latest() -> None:
    store = PlanStore()
    old = _record("gh-a", created_at=NOW - timedelta(days=5))
    store.record(old)

    dropped = store.prune(NOW, RETENTION)

    # The latest plan is kept regardless of age so plans/latest never goes empty (spec 09).
    assert dropped == 0
    assert store.latest("gh-a") is old
    assert store.history("gh-a") == [old]


def test_plan_store_prune_drops_superseded_records_past_retention() -> None:
    store = PlanStore()
    store.record(_record("gh-a", created_at=NOW - timedelta(days=5)))
    latest = _record("gh-a", created_at=NOW)
    store.record(latest)

    assert store.prune(NOW, RETENTION) == 1
    assert store.history("gh-a") == [latest]


def test_rollup_counts_outcomes_and_backlog() -> None:
    store = ServiceStore()
    store.plans.record(_record("gh-a", status=OutcomeStatus.APPLIED))
    store.plans.record(_record("gh-b", status=OutcomeStatus.EXTENDED))
    store.plans.record(
        _record("gh-c", status=OutcomeStatus.ESCALATED, reason_code=ReasonCode.LOW_CONFIDENCE)
    )
    _raise(store.escalations, greenhouse_id="gh-c", reason_code=ReasonCode.LOW_CONFIDENCE)

    rollup = store.rollup(NOW + timedelta(minutes=5))

    assert (rollup.applied, rollup.extended, rollup.escalated) == (1, 1, 1)
    assert rollup.backlog == 1
    assert rollup.oldest_open_escalation_age_seconds == 300.0


def test_sweep_expires_by_ttl_then_prunes_after_retention() -> None:
    store = ServiceStore()
    _raise(store.escalations, now=NOW)

    expired_at = NOW + TTL + timedelta(minutes=1)
    expired, pruned, _records = store.sweep(expired_at, ttl=TTL, retention=RETENTION)

    # Retention is measured from when the escalation *closed*, so it survives this sweep.
    assert (expired, pruned) == (1, 0)
    assert store.escalations.backlog() == 0

    _expired, pruned_later, _r = store.sweep(
        expired_at + RETENTION + timedelta(minutes=1), ttl=TTL, retention=RETENTION
    )
    assert pruned_later == 1


def test_greenhouse_state_is_created_on_demand() -> None:
    store = ServiceStore()
    state = store.fleet.get("gh-a")
    state.consecutive_fidelity_breaches = 2

    assert store.fleet.get("gh-a").consecutive_fidelity_breaches == 2
    assert store.fleet.known_ids() == ["gh-a"]
