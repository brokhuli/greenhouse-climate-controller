"""Request/response shapes for the Service API (spec 10).

Unlike the Phase-2 read/write paths in ``contracts/``, this is the optimizer's **own internal
surface** — spec 10 lists names and intent and defers the concrete schemas to implementation, which
is what this module is. The platform Go API proxies and aggregates these into the *versioned*
``platform-dashboard-rest`` surface the SPA consumes; the browser never calls here directly.

The health shape is deliberately a superset of what the Go API's derived
``GET /api/optimizer/status`` needs (overall status, degraded reason, enabled/read-only state,
last-successful-cycle time, and the cadence to read that age against), so the derivation is a
projection rather than a second computation.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field

from ..models import BackendRole, OutcomeStatus, Provider, ReasonClass, ReasonCode
from ..store import Resolution


class HealthStatus(StrEnum):
    """Overall service health. A read-only pause is healthy — intentional, not a stall (spec 09)."""

    HEALTHY = "healthy"
    DEGRADED = "degraded"


class DegradedReason(StrEnum):
    """Why the service is degraded, mirroring the frontend contract's closed set."""

    PLATFORM_UNREACHABLE = "platform_unreachable"
    LLM_UNREACHABLE = "llm_unreachable"
    CYCLE_STALLED = "cycle_stalled"
    COLD_START = "cold_start"


class HealthResponse(BaseModel):
    """``GET /health`` — the watchdog surface (spec 09 §Health & cadence watchdog)."""

    status: HealthStatus
    degraded_reason: DegradedReason | None = None
    enabled: bool
    read_only_reason: str | None = None
    platform_reachable: bool
    llm_reachable: bool
    last_successful_cycle_at: datetime | None = None
    escalation_backlog: int
    cadence_secs: int


class FleetGreenhouse(BaseModel):
    """One greenhouse's latest cycle outcome plus its per-greenhouse enable flag."""

    greenhouse_id: str
    enabled: bool
    status: OutcomeStatus | None = None
    reason_code: ReasonCode | None = None
    created_at: datetime | None = None
    optimizer_run_id: UUID | None = None


class FleetRollupResponse(BaseModel):
    """Site aggregates so the operator surface reads one endpoint, not N (spec 10)."""

    backlog: int
    applied: int
    escalated: int
    extended: int
    oldest_open_escalation_age_seconds: float | None = None


class FleetResponse(BaseModel):
    """``GET /api/optimizer/fleet``."""

    greenhouses: list[FleetGreenhouse]
    rollup: FleetRollupResponse


class EscalationResponse(BaseModel):
    """One held cycle awaiting review. ``resolution`` (how it closed) is distinct from
    ``reason_code`` (why it was raised)."""

    escalation_id: UUID
    greenhouse_id: str
    reason_code: ReasonCode
    reason_class: ReasonClass
    optimizer_run_id: UUID
    opened_at: datetime
    last_seen_at: datetime
    recurrence_count: int
    message: str | None = None
    resolution: Resolution | None = None
    resolved_at: datetime | None = None


class ModelStateResponse(BaseModel):
    """``GET /api/optimizer/model`` — active backend plus the provider's runtime allowlist."""

    provider: Provider
    model: str
    prompt_version: str
    role: BackendRole
    available_models: list[str]


class ModelSelectionRequest(BaseModel):
    """``POST /api/optimizer/model`` — switch the model within the allowlist."""

    model: str = Field(min_length=1)
    reason: str | None = None


class EnableStateResponse(BaseModel):
    """``GET/POST /api/optimizer/enabled``."""

    enabled: bool
    reason: str | None = None
    changed_at: datetime | None = None


class GreenhouseEnableStateResponse(EnableStateResponse):
    """``GET/POST /api/optimizer/greenhouses/{id}/enabled`` — the scoped analog."""

    greenhouse_id: str


class EnableRequest(BaseModel):
    """Body for either enable scope."""

    enabled: bool
    reason: str | None = None


class CycleRequest(BaseModel):
    """``POST /api/optimizer/greenhouses/{id}/cycles`` — an operator asking to plan now."""

    reason: str | None = None


class ResolveRequest(BaseModel):
    """``POST /api/optimizer/escalations/{id}/resolve``."""

    reason: str | None = None
