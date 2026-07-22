"""The LLM planner (spec 04) — context serialization, the LangChain chain, and the call gate."""

from __future__ import annotations

from .chain import (
    BackendOutput,
    PlannerChain,
    PromptNotFoundError,
    ProviderNotConfiguredError,
    build_chain,
    build_chat_model,
    load_prompt_template,
)
from .planner import (
    Planner,
    PlannerUnavailableError,
    PlanProposal,
    choose_horizon,
)
from .serializer import (
    ContextBudgetExceededError,
    PlanContextPayload,
    build_plan_context,
    estimate_tokens,
)
from .state_change import (
    StateChangeDecision,
    evaluate_state_change,
    forecast_distance,
    hourly_samples,
)

__all__ = [
    "BackendOutput",
    "ContextBudgetExceededError",
    "PlanContextPayload",
    "PlanProposal",
    "Planner",
    "PlannerChain",
    "PlannerUnavailableError",
    "PromptNotFoundError",
    "ProviderNotConfiguredError",
    "StateChangeDecision",
    "build_chain",
    "build_chat_model",
    "build_plan_context",
    "choose_horizon",
    "estimate_tokens",
    "evaluate_state_change",
    "forecast_distance",
    "hourly_samples",
    "load_prompt_template",
]
