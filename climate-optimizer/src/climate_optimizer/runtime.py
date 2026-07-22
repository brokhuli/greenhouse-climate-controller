"""Runtime operator overrides (specs 04, 10, 11) — the only mutable settings.

``model`` and ``enabled`` (service-wide and per-greenhouse) are the three settings an operator may
change at runtime. All three are **in-memory overrides that reset to the configured default on
restart** (spec 10 §Authenticating the enable-disable endpoint): a pause is an operational state, not
a persisted config change. Every mutation is structured-logged with the operator identity and the
supplied reason so who changed what, and when, is recoverable (P3-OBS-1).

The two enable scopes compose as an **AND with the global taking precedence** — a greenhouse plans
only when the service is globally enabled *and* that greenhouse is enabled (spec 09 §Per-greenhouse
pause), which is what :meth:`RuntimeState.is_greenhouse_active` answers for the scheduler.

The ``provider`` is deliberately **not** mutable here: a provider change shifts the plan distribution
and swaps the evaluation baselines, so it stays an offline, ADR-governed config change (spec 04).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from .config import Settings
from .models import Provider

logger = logging.getLogger(__name__)


class ModelNotAllowedError(ValueError):
    """Raised when a requested model is not in the active provider's ``available_models``."""

    def __init__(self, model: str, provider: Provider, allowed: list[str]) -> None:
        super().__init__(
            f"model {model!r} is not in available_models for provider {provider.value!r} "
            f"(allowed: {', '.join(allowed) if allowed else 'none'})"
        )
        self.model = model
        self.provider = provider
        self.allowed = allowed


@dataclass(frozen=True)
class EnableState:
    """An enable flag plus the operator context of the last change to it."""

    enabled: bool
    reason: str | None = None
    changed_at: datetime | None = None
    changed_by: str | None = None


def _now() -> datetime:
    return datetime.now(UTC)


class RuntimeState:
    """In-memory operator overrides layered over :class:`~climate_optimizer.config.Settings`."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._enabled = EnableState(enabled=settings.service.enabled)
        self._greenhouses: dict[str, EnableState] = {}
        self._model = settings.llm.model

    # -- service-wide enable ------------------------------------------------

    @property
    def enabled(self) -> EnableState:
        """The service-wide enable flag (disabled ⇒ read-only mode, spec 09)."""
        return self._enabled

    def set_enabled(
        self, enabled: bool, *, reason: str | None = None, actor: str | None = None
    ) -> EnableState:
        """Pause or resume the whole optimizer; takes effect immediately (spec 09)."""
        self._enabled = EnableState(
            enabled=enabled, reason=reason, changed_at=_now(), changed_by=actor
        )
        logger.info(
            "optimizer enabled flag changed",
            extra={
                "event": "optimizer_enabled_changed",
                "enabled": enabled,
                "reason": reason,
                "actor": actor,
            },
        )
        return self._enabled

    @property
    def read_only_reason(self) -> str | None:
        """Why the service is read-only, or ``None`` while planning is enabled."""
        if self._enabled.enabled:
            return None
        return self._enabled.reason or "optimizer disabled by operator"

    # -- per-greenhouse enable ----------------------------------------------

    def greenhouse_enabled(self, greenhouse_id: str) -> EnableState:
        """One greenhouse's own flag — default on (there is no per-greenhouse config, spec 09)."""
        return self._greenhouses.get(greenhouse_id, EnableState(enabled=True))

    def set_greenhouse_enabled(
        self,
        greenhouse_id: str,
        enabled: bool,
        *,
        reason: str | None = None,
        actor: str | None = None,
    ) -> EnableState:
        """Pause or resume planning for a single greenhouse (spec 09 §Per-greenhouse pause)."""
        state = EnableState(enabled=enabled, reason=reason, changed_at=_now(), changed_by=actor)
        self._greenhouses[greenhouse_id] = state
        logger.info(
            "greenhouse optimizer enabled flag changed",
            extra={
                "event": "optimizer_greenhouse_enabled_changed",
                "greenhouse_id": greenhouse_id,
                "enabled": enabled,
                "reason": reason,
                "actor": actor,
            },
        )
        return state

    def is_greenhouse_active(self, greenhouse_id: str) -> bool:
        """Global AND per-greenhouse, with the global pause taking precedence (spec 09)."""
        return self._enabled.enabled and self.greenhouse_enabled(greenhouse_id).enabled

    # -- active model -------------------------------------------------------

    @property
    def provider(self) -> Provider:
        """The active provider — offline config only, never mutable at runtime (spec 04)."""
        return self._settings.llm.provider

    @property
    def model(self) -> str:
        """The active model id, stamped into every subsequent ``PlanRecord.backend.model``."""
        return self._model

    @property
    def available_models(self) -> list[str]:
        """The active provider's runtime allowlist (spec 11)."""
        return list(self._settings.llm.available_models.get(self.provider.value, []))

    def set_model(self, model: str, *, reason: str | None = None, actor: str | None = None) -> str:
        """Switch the active model within the allowlist; takes effect on the **next** cycle.

        Raises :class:`ModelNotAllowedError` when the model is not pre-vetted for the active
        provider — every allowlisted model is baseline-captured offline before it can be selected
        (spec 08 §3), so runtime switching never escapes the reproducibility discipline.
        """
        allowed = self.available_models
        if model not in allowed:
            raise ModelNotAllowedError(model, self.provider, allowed)
        self._model = model
        logger.info(
            "optimizer model changed",
            extra={
                "event": "optimizer_model_changed",
                "provider": self.provider.value,
                "model": model,
                "reason": reason,
                "actor": actor,
            },
        )
        return self._model
