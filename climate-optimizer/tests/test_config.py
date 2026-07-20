"""Configuration binds spec-11 defaults, honors env overrides, masks secrets, and fails fast."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from climate_optimizer.config import Settings
from climate_optimizer.models import Metric, Provider


def test_defaults_match_spec() -> None:
    settings = Settings()
    assert settings.twin.divergence_threshold == 0.15
    assert settings.twin.fidelity_breach_cycles == 3
    assert settings.application.confidence_threshold == 0.8
    assert settings.planning.cycle_interval_minutes == 30
    assert settings.service.max_concurrent_cycles == 4
    assert settings.llm.provider is Provider.OLLAMA
    assert settings.llm.model == "qwen2.5:7b"
    assert settings.data_quality.required_metrics == [
        Metric.TEMPERATURE,
        Metric.HUMIDITY,
        Metric.CO2,
        Metric.PAR,
    ]
    assert len(settings.cost.time_of_use) == 4


def test_nested_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPTIMIZER_TWIN__DIVERGENCE_THRESHOLD", "0.25")
    monkeypatch.setenv("OPTIMIZER_APPLICATION__CONFIDENCE_THRESHOLD", "0.6")
    settings = Settings()
    assert settings.twin.divergence_threshold == 0.25
    assert settings.application.confidence_threshold == 0.6


def test_secret_from_fixed_env_and_masked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PLANNER_API_KEY", "super-secret")
    settings = Settings()
    assert settings.planner_api_key.get_secret_value() == "super-secret"
    assert "super-secret" not in repr(settings)
    assert "super-secret" not in str(settings)


def test_bad_value_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPTIMIZER_APPLICATION__CONFIDENCE_THRESHOLD", "1.5")
    with pytest.raises(ValidationError):
        Settings()


def test_bad_auth_mode_fails_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPTIMIZER_PLATFORM_AUTH__MODE", "carrier-pigeon")
    with pytest.raises(ValidationError):
        Settings()
