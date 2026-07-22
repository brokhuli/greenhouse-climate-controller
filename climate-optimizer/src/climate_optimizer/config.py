"""Service configuration (spec 11) — env / Compose bound to typed, validated settings.

``pydantic-settings`` binds environment variables to nested typed settings and **fails fast at
load** on a bad value (the Python analog of the controller's serde/toml boundary). Non-secret keys
bind under the ``OPTIMIZER_`` prefix with a ``__`` group delimiter (e.g.
``OPTIMIZER_TWIN__DIVERGENCE_THRESHOLD``); the defaults here are the spec-11 values. The two secrets
(``PLANNER_API_KEY``, ``PLANNER_OIDC_CLIENT_SECRET``) resolve from their fixed env names only, are
held as ``SecretStr`` so they never land in a log, and are never read from a file (spec 11 / P3-SEC-1).

``model`` and ``enabled`` are the only runtime-mutable settings (spec 11). The values here are the
**configured defaults**; the live, operator-mutable values are the in-memory overrides held by
:class:`~climate_optimizer.runtime.RuntimeState`, which reset to these defaults on restart.
"""

from __future__ import annotations

from pydantic import BaseModel, Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from .models.enums import Metric, Provider

HHMM_OR_24 = r"^([01][0-9]|2[0-4]):[0-5][0-9]$"


class _Group(BaseModel):
    model_config = {"extra": "forbid"}


class DataSettings(_Group):
    """[data] — the Phase 2 platform endpoint the optimizer reads and writes through."""

    platform_api_url: str = "http://api:8080/api"


class PlatformAuthSettings(_Group):
    """[platform_auth] — service-to-service auth mode for the Phase 2 setpoint write (RFC-011)."""

    mode: str = Field(default="trusted_network", pattern=r"^(trusted_network|oidc)$")
    oidc_token_url: str = ""
    oidc_client_id: str = "optimizer"


class OperatorAuthSettings(_Group):
    """[operator_auth] — inbound verification for the operator-gated endpoints (spec 10).

    The deployment posture switch is ``platform_auth.mode`` (RFC-011), shared with the outbound
    write path: under ``trusted_network`` the operator endpoints are untokened like the rest of the
    single-host local surface; under ``oidc`` the caller must present a Keycloak token carrying the
    operator role. Only the *verification parameters* live here — spec 11 predates the service slice
    and enumerates no inbound-auth keys.
    """

    jwks_url: str = ""
    issuer: str = ""
    audience: str = "climate-api"
    role: str = "operator"


class LlmSettings(_Group):
    """[llm] — planning backend. ``provider`` is offline; ``model`` is operator-mutable at runtime."""

    provider: Provider = Provider.OLLAMA
    model: str = "qwen2.5:7b"
    prompt_version: str = Field(default="v1", min_length=1)
    endpoint: str = "http://ollama:11434"
    fallback_provider: str = ""
    fallback_model: str = ""
    fallback_endpoint: str = ""
    temperature: float = Field(default=0.0, ge=0)
    top_p: float = Field(default=1.0, ge=0, le=1)
    output_token_budget: int = Field(default=640, gt=0)
    available_models: dict[str, list[str]] = Field(
        default_factory=lambda: {
            "ollama": ["llama3.2", "mistral", "qwen2.5:7b", "llama3.1:8b"],
            "anthropic": [],
            "openai": [],
        }
    )


class ObjectiveWeights(_Group):
    """[planning].objective_weights — relative weight of each optimization objective."""

    anticipation: float = Field(default=1.0, ge=0)
    coupling: float = Field(default=1.0, ge=0)
    efficiency: float = Field(default=0.5, ge=0)


class PlanningSettings(_Group):
    """[planning] — cadence, horizon, context budget, and the state-change suppression threshold."""

    cycle_interval_minutes: int = Field(default=30, gt=0)
    horizon_hours: int = Field(default=12, gt=0)
    context_token_budget: int = Field(default=3000, gt=0)
    state_change_threshold: float = Field(default=0.05, ge=0)
    objective_weights: ObjectiveWeights = Field(default_factory=ObjectiveWeights)


class TimeOfUseBlock(_Group):
    """One [cost].time_of_use window — a relative energy cost over a time-of-day span."""

    start: str = Field(pattern=HHMM_OR_24)
    end: str = Field(pattern=HHMM_OR_24)
    relative_cost: float = Field(ge=0)


def _default_time_of_use() -> list[TimeOfUseBlock]:
    return [
        TimeOfUseBlock(start="00:00", end="06:00", relative_cost=0.7),
        TimeOfUseBlock(start="06:00", end="16:00", relative_cost=1.0),
        TimeOfUseBlock(start="16:00", end="21:00", relative_cost=1.4),
        TimeOfUseBlock(start="21:00", end="24:00", relative_cost=0.8),
    ]


class CostSettings(_Group):
    """[cost] — the local static time-of-use schedule for the efficiency objective."""

    time_of_use: list[TimeOfUseBlock] = Field(default_factory=_default_time_of_use)


class ApplicationSettings(_Group):
    """[application] — the auto-apply confidence gate (crop-safe bounds come from Phase 2)."""

    confidence_threshold: float = Field(default=0.8, ge=0, le=1)


class DataQualitySettings(_Group):
    """[data_quality] — the input-gate freshness / completeness thresholds."""

    max_telemetry_age_minutes: float = Field(default=35.0, gt=0)
    required_metrics: list[Metric] = Field(
        default_factory=lambda: [Metric.TEMPERATURE, Metric.HUMIDITY, Metric.CO2, Metric.PAR]
    )
    min_history_coverage: float = Field(default=0.8, ge=0, le=1)


class TwinSettings(_Group):
    """[twin] — integrator step ceiling, output spacing, and divergence / fidelity thresholds."""

    solver_max_step_minutes: float = Field(default=5.0, gt=0)
    output_interval_minutes: float = Field(default=60.0, gt=0)
    divergence_threshold: float = Field(default=0.15, ge=0)
    fidelity_breach_cycles: int = Field(default=3, ge=1)


class ServiceSettings(_Group):
    """[service] — scheduler enable, concurrency, timeout, and escalation lifecycle windows."""

    enabled: bool = True
    max_concurrent_cycles: int = Field(default=4, ge=1)
    cycle_timeout_seconds: float = Field(default=90.0, gt=0)
    escalation_dedup_window_minutes: float = Field(default=60.0, gt=0)
    escalation_ttl_minutes: float = Field(default=1440.0, gt=0)
    escalation_retention_minutes: float = Field(default=1440.0, gt=0)


class Settings(BaseSettings):
    """The optimizer's full service configuration, loaded from env / Compose."""

    model_config = SettingsConfigDict(
        env_prefix="OPTIMIZER_",
        env_nested_delimiter="__",
        case_sensitive=False,
        extra="ignore",
    )

    data: DataSettings = Field(default_factory=DataSettings)
    platform_auth: PlatformAuthSettings = Field(default_factory=PlatformAuthSettings)
    operator_auth: OperatorAuthSettings = Field(default_factory=OperatorAuthSettings)
    llm: LlmSettings = Field(default_factory=LlmSettings)
    planning: PlanningSettings = Field(default_factory=PlanningSettings)
    cost: CostSettings = Field(default_factory=CostSettings)
    application: ApplicationSettings = Field(default_factory=ApplicationSettings)
    data_quality: DataQualitySettings = Field(default_factory=DataQualitySettings)
    twin: TwinSettings = Field(default_factory=TwinSettings)
    service: ServiceSettings = Field(default_factory=ServiceSettings)

    # Secrets: fixed env names (validation_alias bypasses OPTIMIZER_ prefix), env-only, never logged.
    planner_api_key: SecretStr = Field(default=SecretStr(""), validation_alias="PLANNER_API_KEY")
    planner_oidc_client_secret: SecretStr = Field(
        default=SecretStr(""), validation_alias="PLANNER_OIDC_CLIENT_SECRET"
    )


def load_settings() -> Settings:
    """Load settings from the current environment (fails fast on a bad value)."""
    return Settings()
