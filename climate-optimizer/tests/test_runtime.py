"""Runtime operator overrides — the three mutable settings and how the enable scopes compose."""

from __future__ import annotations

import pytest

from climate_optimizer.config import Settings
from climate_optimizer.models import Provider
from climate_optimizer.runtime import ModelNotAllowedError, RuntimeState


def test_defaults_come_from_config() -> None:
    runtime = RuntimeState(Settings())
    assert runtime.enabled.enabled is True
    assert runtime.model == "qwen2.5:7b"
    assert runtime.provider is Provider.OLLAMA
    assert runtime.read_only_reason is None


def test_disabling_reports_a_read_only_reason() -> None:
    runtime = RuntimeState(Settings())
    state = runtime.set_enabled(False, reason="maintenance", actor="alice")

    assert state.enabled is False
    assert state.changed_by == "alice"
    assert runtime.read_only_reason == "maintenance"


def test_disabling_without_a_reason_still_explains_itself() -> None:
    runtime = RuntimeState(Settings())
    runtime.set_enabled(False)
    assert runtime.read_only_reason == "optimizer disabled by operator"


def test_greenhouses_default_to_enabled() -> None:
    runtime = RuntimeState(Settings())
    assert runtime.greenhouse_enabled("gh-unknown").enabled is True
    assert runtime.is_greenhouse_active("gh-unknown") is True


def test_per_greenhouse_pause_leaves_the_rest_of_the_fleet_planning() -> None:
    runtime = RuntimeState(Settings())
    runtime.set_greenhouse_enabled("gh-a", False, reason="sensor swap")

    assert runtime.is_greenhouse_active("gh-a") is False
    assert runtime.is_greenhouse_active("gh-b") is True


def test_global_pause_takes_precedence_over_an_enabled_greenhouse() -> None:
    runtime = RuntimeState(Settings())
    runtime.set_greenhouse_enabled("gh-a", True)
    runtime.set_enabled(False)

    # The two scopes compose as an AND with the global winning (spec 09).
    assert runtime.is_greenhouse_active("gh-a") is False

    runtime.set_enabled(True)
    assert runtime.is_greenhouse_active("gh-a") is True


def test_resuming_the_service_restores_each_greenhouses_own_flag() -> None:
    runtime = RuntimeState(Settings())
    runtime.set_greenhouse_enabled("gh-a", False)
    runtime.set_enabled(False)
    runtime.set_enabled(True)

    assert runtime.is_greenhouse_active("gh-a") is False
    assert runtime.is_greenhouse_active("gh-b") is True


def test_model_switch_within_the_allowlist() -> None:
    runtime = RuntimeState(Settings())
    runtime.set_model("mistral", reason="A/B", actor="alice")
    assert runtime.model == "mistral"


def test_model_outside_the_allowlist_is_rejected() -> None:
    runtime = RuntimeState(Settings())
    with pytest.raises(ModelNotAllowedError):
        runtime.set_model("not-vetted")
    assert runtime.model == "qwen2.5:7b"


def test_available_models_tracks_the_active_provider() -> None:
    runtime = RuntimeState(Settings())
    assert "qwen2.5:7b" in runtime.available_models

    anthropic = RuntimeState(
        Settings(llm={"provider": "anthropic", "available_models": {"anthropic": ["claude-x"]}})
    )
    assert anthropic.available_models == ["claude-x"]


def test_overrides_are_in_memory_and_reset_from_config() -> None:
    settings = Settings()
    runtime = RuntimeState(settings)
    runtime.set_model("mistral")
    runtime.set_enabled(False)

    # A restart rebuilds from the configured defaults — nothing is persisted (spec 10).
    restarted = RuntimeState(settings)
    assert restarted.model == "qwen2.5:7b"
    assert restarted.enabled.enabled is True
