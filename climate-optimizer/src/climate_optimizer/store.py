"""In-memory service state (specs 05, 09, 10) — plan records, escalations, per-greenhouse memory.

The optimizer holds **no authoritative persistent state**: intended state lives in Phase 2 (spec 09
§Stateless restart). What it does keep is an operator surface — the latest ``PlanRecord`` per
greenhouse and the open escalation set — plus the small cross-cycle planner memory a cycle needs
(:class:`GreenhouseState`). All of it is per-service memory a restart clears and cycles re-derive, so
the periodic sweep bounds growth *between* restarts, not across them.

**Escalation lifecycle** (spec 09 §Escalation lifecycle). An escalation is *open* from when it is
raised until it closes one of three ways: ``operator`` (acted on), ``superseded`` (a later cycle for
the same greenhouse produced a fresh outcome), or ``expired`` (neither acted on nor re-raised within
the TTL). The *resolution* — how it closed — is recorded distinctly from the *reason code* — why it
was raised.

**Deduplication.** While an escalation for a (greenhouse, reason) pair is open, a recurrence folds
into that single **standing** entry, bumping ``recurrence_count`` and ``last_seen_at`` rather than
minting one fresh escalation per cycle — a recurring identical fault never supersedes itself. The
``escalation_dedup_window_minutes`` knob rate-limits the *operator-facing signal*: a recurrence is
only re-logged once the window has elapsed since it was last seen, so a stuck sensor failing every
cadence bounds operator load without dropping the count.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import StrEnum
from uuid import UUID, uuid4

from .models import (
    REASON_CLASS,
    OutcomeStatus,
    PlanRecord,
    ReasonClass,
    ReasonCode,
    SetpointsPatch,
    TrajectoryPoint,
)
from .twin import PredictedPoint

logger = logging.getLogger(__name__)

# Per-greenhouse plan history kept for inspection; the sweep prunes it and the latest is never dropped.
_MAX_HISTORY_PER_GREENHOUSE = 64


class Resolution(StrEnum):
    """How an open escalation closed (distinct from the reason code it was raised with)."""

    OPERATOR = "operator"
    SUPERSEDED = "superseded"
    EXPIRED = "expired"


@dataclass
class Escalation:
    """One held cycle awaiting operator review, or the record of how it closed."""

    escalation_id: UUID
    greenhouse_id: str
    reason_code: ReasonCode
    reason_class: ReasonClass
    optimizer_run_id: UUID
    opened_at: datetime
    last_seen_at: datetime
    message: str | None = None
    recurrence_count: int = 1
    resolution: Resolution | None = None
    resolved_at: datetime | None = None
    resolved_by: str | None = None

    @property
    def is_open(self) -> bool:
        return self.resolution is None

    def age_seconds(self, now: datetime) -> float:
        return (now - self.opened_at).total_seconds()


@dataclass
class GreenhouseState:
    """The cross-cycle planner memory for one greenhouse — in-memory only (spec 09).

    ``last_applied_*`` is the optimizer's own accepted bundle (the baseline held in force while a
    cycle is held); ``last_forecast`` is the previous cycle's predicted climate, used for the twin's
    one-step-ahead fidelity residual; ``reference_forecast`` is the forecast retained from the last
    cycle that actually *ran the planner*, which is what the state-change gate diffs against. The
    last two are deliberately distinct (spec 04 §Invocation strategy).
    """

    last_applied_plan_id: UUID | None = None
    last_applied_setpoints: SetpointsPatch | None = None
    retained_trajectory: list[TrajectoryPoint] | None = None
    last_forecast: list[PredictedPoint] | None = None
    reference_forecast: list[PredictedPoint] | None = None
    consecutive_fidelity_breaches: int = 0


@dataclass(frozen=True)
class FleetRollup:
    """Site aggregates for the operator overview (spec 10 ``GET /api/optimizer/fleet``)."""

    backlog: int
    applied: int
    escalated: int
    extended: int
    oldest_open_escalation_age_seconds: float | None


class PlanStore:
    """The latest ``PlanRecord`` per greenhouse plus a bounded history."""

    def __init__(self) -> None:
        self._latest: dict[str, PlanRecord] = {}
        self._history: dict[str, deque[PlanRecord]] = {}

    def record(self, plan_record: PlanRecord) -> None:
        """Store a completed cycle's record as that greenhouse's latest."""
        greenhouse_id = plan_record.greenhouse_id
        self._latest[greenhouse_id] = plan_record
        history = self._history.setdefault(greenhouse_id, deque(maxlen=_MAX_HISTORY_PER_GREENHOUSE))
        history.append(plan_record)

    def latest(self, greenhouse_id: str) -> PlanRecord | None:
        """The most recent record for one greenhouse (``GET .../plans/latest``)."""
        return self._latest.get(greenhouse_id)

    def all_latest(self) -> dict[str, PlanRecord]:
        return dict(self._latest)

    def history(self, greenhouse_id: str) -> list[PlanRecord]:
        return list(self._history.get(greenhouse_id, ()))

    def outcome_counts(self) -> dict[OutcomeStatus, int]:
        """Counts by latest outcome across the fleet."""
        counts = dict.fromkeys(OutcomeStatus, 0)
        for record in self._latest.values():
            counts[record.outcome.status] += 1
        return counts

    def prune(self, now: datetime, retention: timedelta) -> int:
        """Drop held records past the retention window; the latest per greenhouse is always kept."""
        dropped = 0
        for greenhouse_id, history in self._history.items():
            latest = self._latest.get(greenhouse_id)
            keep = deque(
                (
                    record
                    for record in history
                    if record is latest or now - record.created_at <= retention
                ),
                maxlen=_MAX_HISTORY_PER_GREENHOUSE,
            )
            dropped += len(history) - len(keep)
            self._history[greenhouse_id] = keep
        return dropped


class EscalationRegistry:
    """The open escalation set and its lifecycle (raise/dedup, supersede, expire, resolve, prune)."""

    def __init__(self) -> None:
        self._items: dict[UUID, Escalation] = {}

    def _open_for(self, greenhouse_id: str, reason_code: ReasonCode) -> Escalation | None:
        for item in self._items.values():
            if (
                item.is_open
                and item.greenhouse_id == greenhouse_id
                and item.reason_code == reason_code
            ):
                return item
        return None

    def raise_escalation(
        self,
        *,
        greenhouse_id: str,
        reason_code: ReasonCode,
        optimizer_run_id: UUID,
        message: str | None,
        now: datetime,
        dedup_window: timedelta,
    ) -> Escalation:
        """Open an escalation, or fold a recurrence into the existing standing entry."""
        standing = self._open_for(greenhouse_id, reason_code)
        if standing is not None:
            quiet_for = now - standing.last_seen_at
            standing.recurrence_count += 1
            standing.last_seen_at = now
            standing.optimizer_run_id = optimizer_run_id
            standing.message = message or standing.message
            if quiet_for > dedup_window:
                # Rate-limited: only re-surface once the dedup window has elapsed since last seen.
                logger.warning(
                    "escalation recurring",
                    extra={
                        "event": "optimizer_escalation_recurring",
                        "escalation_id": str(standing.escalation_id),
                        "greenhouse_id": greenhouse_id,
                        "reason_code": reason_code.value,
                        "recurrence_count": standing.recurrence_count,
                    },
                )
            return standing

        escalation = Escalation(
            escalation_id=uuid4(),
            greenhouse_id=greenhouse_id,
            reason_code=reason_code,
            reason_class=REASON_CLASS[reason_code],
            optimizer_run_id=optimizer_run_id,
            opened_at=now,
            last_seen_at=now,
            message=message,
        )
        self._items[escalation.escalation_id] = escalation
        logger.warning(
            "escalation opened",
            extra={
                "event": "optimizer_escalation_opened",
                "escalation_id": str(escalation.escalation_id),
                "greenhouse_id": greenhouse_id,
                "reason_code": reason_code.value,
                "reason_class": escalation.reason_class.value,
                "optimizer_run_id": str(optimizer_run_id),
            },
        )
        return escalation

    def supersede(
        self, greenhouse_id: str, *, now: datetime, except_reason: ReasonCode | None = None
    ) -> int:
        """Close a greenhouse's open escalations after a fresh outcome (spec 09).

        ``except_reason`` is the reason the new cycle itself escalated with, if any: an identical
        recurring fault folds into its standing entry instead of superseding itself.
        """
        closed = 0
        for item in self._items.values():
            if not item.is_open or item.greenhouse_id != greenhouse_id:
                continue
            if except_reason is not None and item.reason_code == except_reason:
                continue
            self._close(item, Resolution.SUPERSEDED, now)
            closed += 1
        return closed

    def expire(self, now: datetime, ttl: timedelta) -> int:
        """Close open escalations neither acted on nor re-raised within the TTL (spec 09)."""
        expired = 0
        for item in self._items.values():
            if item.is_open and now - item.last_seen_at > ttl:
                self._close(item, Resolution.EXPIRED, now)
                expired += 1
        return expired

    def resolve(
        self, escalation_id: UUID, *, now: datetime, actor: str | None = None
    ) -> Escalation | None:
        """Operator resolution; returns ``None`` when unknown or already closed."""
        item = self._items.get(escalation_id)
        if item is None or not item.is_open:
            return None
        self._close(item, Resolution.OPERATOR, now, actor=actor)
        return item

    def _close(
        self,
        item: Escalation,
        resolution: Resolution,
        now: datetime,
        *,
        actor: str | None = None,
    ) -> None:
        item.resolution = resolution
        item.resolved_at = now
        item.resolved_by = actor
        logger.info(
            "escalation closed",
            extra={
                "event": "optimizer_escalation_closed",
                "escalation_id": str(item.escalation_id),
                "greenhouse_id": item.greenhouse_id,
                "reason_code": item.reason_code.value,
                "resolution": resolution.value,
                "actor": actor,
            },
        )

    def get(self, escalation_id: UUID) -> Escalation | None:
        return self._items.get(escalation_id)

    def open_escalations(self) -> list[Escalation]:
        """The open set, triage-ordered: persistent before transient, then oldest first."""
        return sorted(
            (item for item in self._items.values() if item.is_open),
            key=lambda e: (e.reason_class is not ReasonClass.PERSISTENT, e.opened_at),
        )

    def open_for_greenhouse(self, greenhouse_id: str) -> list[Escalation]:
        return [item for item in self.open_escalations() if item.greenhouse_id == greenhouse_id]

    def backlog(self) -> int:
        """The open-escalation count — the same scalar ``GET /health`` surfaces (spec 10)."""
        return sum(1 for item in self._items.values() if item.is_open)

    def oldest_open_age_seconds(self, now: datetime) -> float | None:
        ages = [item.age_seconds(now) for item in self._items.values() if item.is_open]
        return max(ages) if ages else None

    def prune(self, now: datetime, retention: timedelta) -> int:
        """Drop closed escalations past the retention window."""
        stale = [
            key
            for key, item in self._items.items()
            if item.resolved_at is not None and now - item.resolved_at > retention
        ]
        for key in stale:
            del self._items[key]
        return len(stale)


class FleetState:
    """Per-greenhouse cross-cycle planner memory, created on demand."""

    def __init__(self) -> None:
        self._states: dict[str, GreenhouseState] = {}

    def get(self, greenhouse_id: str) -> GreenhouseState:
        return self._states.setdefault(greenhouse_id, GreenhouseState())

    def known_ids(self) -> list[str]:
        return list(self._states)


@dataclass
class ServiceStore:
    """The service's whole in-memory surface, passed to the cycle, scheduler, and routes."""

    plans: PlanStore = field(default_factory=PlanStore)
    escalations: EscalationRegistry = field(default_factory=EscalationRegistry)
    fleet: FleetState = field(default_factory=FleetState)
    last_successful_cycle_at: datetime | None = None

    def rollup(self, now: datetime) -> FleetRollup:
        """Site aggregates for ``GET /api/optimizer/fleet``."""
        counts = self.plans.outcome_counts()
        return FleetRollup(
            backlog=self.escalations.backlog(),
            applied=counts[OutcomeStatus.APPLIED],
            escalated=counts[OutcomeStatus.ESCALATED],
            extended=counts[OutcomeStatus.EXTENDED],
            oldest_open_escalation_age_seconds=self.escalations.oldest_open_age_seconds(now),
        )

    def sweep(self, now: datetime, *, ttl: timedelta, retention: timedelta) -> tuple[int, int, int]:
        """The periodic sweep: expire by TTL, then prune closed escalations and held records.

        Runs independently of the planning scheduler so it fires even while the optimizer is
        disabled (spec 09). Returns ``(expired, escalations_pruned, records_pruned)``.
        """
        expired = self.escalations.expire(now, ttl)
        pruned = self.escalations.prune(now, retention)
        records = self.plans.prune(now, retention)
        return expired, pruned, records
