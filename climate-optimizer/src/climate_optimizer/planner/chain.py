"""The LangChain planner chain (spec 04 §1, spec 12 §LLM planning).

The planner is the chain ``ChatPromptTemplate | LLM | StructuredOutputParser``, with the model's
one semantic decision parsed via ``.with_structured_output(SetpointDecision)`` — a deliberately
*small* structured shape (the immediate setpoint bundle plus confidence and explanation) — and an
optional secondary backend wired through ``.with_fallbacks([...])``. LangChain's composition
replaces bespoke prompt construction, output parsing, and try/catch failover, keeping the invocation
strategy backend-agnostic (P3-MOD-1, RFC-004). The full ``OptimizerPlan`` (timestamp, single-point
trajectory, ``immediate_setpoints`` equality) is assembled deterministically downstream in
:meth:`~climate_optimizer.planner.planner.Planner.propose`, not by the model.

For the Ollama backend the structured output pins ``method="json_schema"`` — Ollama's JSON-Schema
constrained decoding (grammar) — so a small local model's completion always parses and matches the
shape; cloud backends keep their tool-calling default.

Each backend leg stamps its own :class:`BackendOutput` provenance, so a failover is *recorded* rather
than hidden: the fallback is a different model held to its own evaluation baseline, and every plan
carries the ``(provider, model, prompt_version, role)`` tuple it was produced by (P3-OBS-1).

Sampling is pinned — ``temperature=0``, ``top_p=1.0``, and ``output_token_budget`` as the response
cap — applied identically to whichever wrapper is active, so plans are reproducible enough to
regression-test (spec 04 §Determinism).

The prompt is a **checked-in versioned asset**, not an inline string: ``prompts/planner.v{N}.md``
resolved by ``prompt_version`` at construction. A released template is immutable — a change ships
``v{N+1}`` and bumps the pin, so ``prompt_version`` always names the exact text that ran.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.runnables import Runnable, RunnableLambda
from pydantic import BaseModel

from ..config import Settings
from ..models import BackendRole, OptimizerPlan, Provider, SetpointDecision


class PromptNotFoundError(Exception):
    """The pinned ``prompt_version`` does not resolve to a checked-in template."""


class ProviderNotConfiguredError(Exception):
    """A cloud provider was selected without the credential it needs (fail fast, spec 09)."""


@dataclass(frozen=True)
class BackendDraft:
    """The model's raw structured decision plus the backend provenance that produced it.

    What the chain returns: the small :class:`SetpointDecision` the model emitted, stamped with the
    ``(provider, model, role)`` it came from. :meth:`Planner.propose` clamps it to the crop-safe
    bounds and assembles the full :class:`BackendOutput`.
    """

    decision: SetpointDecision
    provider: Provider
    model: str
    role: BackendRole


@dataclass(frozen=True)
class BackendOutput:
    """The assembled plan plus the backend provenance that produced it (built in ``propose``)."""

    plan: OptimizerPlan
    provider: Provider
    model: str
    role: BackendRole


# The chain's input is the templated human turn; its output is the model's decision plus provenance.
PlannerChain = Runnable[dict[str, Any], BackendDraft]


def _prompts_dir() -> Path:
    override = os.environ.get("CLIMATE_OPTIMIZER_PROMPTS_DIR")
    if override:
        return Path(override)
    # src/climate_optimizer/planner/chain.py -> planner -> climate_optimizer -> src -> module root
    return Path(__file__).resolve().parents[3] / "prompts"


@lru_cache(maxsize=8)
def load_prompt_template(prompt_version: str) -> str:
    """Read the pinned planner system prompt (``prompts/planner.v{N}.md``)."""
    path = _prompts_dir() / f"planner.{prompt_version}.md"
    if not path.is_file():
        raise PromptNotFoundError(f"no planner prompt template at {path}")
    return path.read_text(encoding="utf-8")


def build_chat_model(
    settings: Settings, *, provider: Provider, model: str, endpoint: str
) -> BaseChatModel:
    """Construct the configured chat-model wrapper with the pinned sampling parameters."""
    llm = settings.llm
    api_key = settings.planner_api_key.get_secret_value()

    if provider is Provider.OLLAMA:
        from langchain_ollama import ChatOllama

        # Ollama is the default local backend: offline, key-free. num_predict is its max-tokens cap.
        return ChatOllama(
            model=model,
            base_url=endpoint,
            temperature=llm.temperature,
            top_p=llm.top_p,
            num_predict=llm.output_token_budget,
        )

    if not api_key:
        raise ProviderNotConfiguredError(
            f"provider {provider.value!r} requires PLANNER_API_KEY to be set"
        )

    if provider is Provider.ANTHROPIC:
        from langchain_anthropic import ChatAnthropic

        return ChatAnthropic(
            model=model,
            api_key=api_key,
            temperature=llm.temperature,
            top_p=llm.top_p,
            max_tokens=llm.output_token_budget,
            timeout=None,
            stop=None,
        )

    from langchain_openai import ChatOpenAI

    return ChatOpenAI(
        model=model,
        api_key=api_key,
        temperature=llm.temperature,
        top_p=llm.top_p,
        max_completion_tokens=llm.output_token_budget,
    )


def _leg(
    prompt: ChatPromptTemplate,
    chat_model: BaseChatModel,
    *,
    provider: Provider,
    model: str,
    role: BackendRole,
) -> PlannerChain:
    """One backend's chain: prompt → structured decision → provenance-stamped draft."""

    def stamp(parsed: dict[str, Any] | BaseModel) -> BackendDraft:
        # ``with_structured_output`` may hand back either the parsed model or a raw dict depending
        # on the backend's tool-calling support; normalize to the validated model either way.
        if isinstance(parsed, SetpointDecision):
            decision = parsed
        else:
            payload = parsed if isinstance(parsed, dict) else parsed.model_dump()
            decision = SetpointDecision.model_validate(payload)
        return BackendDraft(decision=decision, provider=provider, model=model, role=role)

    # Ollama pins JSON-Schema constrained decoding (grammar) so the completion always parses and
    # matches the shape; cloud backends keep their tool-calling default.
    if provider is Provider.OLLAMA:
        structured = chat_model.with_structured_output(SetpointDecision, method="json_schema")
    else:
        structured = chat_model.with_structured_output(SetpointDecision)
    stamper = RunnableLambda[dict[str, Any] | BaseModel, BackendDraft](stamp)
    chain: PlannerChain = prompt | structured | stamper
    return chain


def build_chain(settings: Settings, *, model: str) -> PlannerChain:
    """Build the planner chain for the active model, with the configured fallback when present.

    ``model`` is the runtime-selected id (:class:`~climate_optimizer.runtime.RuntimeState`), which
    may differ from the configured default; ``provider`` and ``prompt_version`` are offline pins.
    """
    llm = settings.llm
    system_prompt = load_prompt_template(llm.prompt_version)
    prompt = ChatPromptTemplate.from_messages(
        # The system text is passed as a value, not a template, so braces in the checked-in prompt
        # are never interpreted as template variables.
        [("system", "{system_prompt}"), ("human", "{plan_context}")]
    ).partial(system_prompt=system_prompt)

    primary = _leg(
        prompt,
        build_chat_model(settings, provider=llm.provider, model=model, endpoint=llm.endpoint),
        provider=llm.provider,
        model=model,
        role=BackendRole.PRIMARY,
    )

    if not (llm.fallback_provider and llm.fallback_model):
        return primary

    fallback_provider = Provider(llm.fallback_provider)
    fallback = _leg(
        prompt,
        build_chat_model(
            settings,
            provider=fallback_provider,
            model=llm.fallback_model,
            endpoint=llm.fallback_endpoint or llm.endpoint,
        ),
        provider=fallback_provider,
        model=llm.fallback_model,
        role=BackendRole.FALLBACK,
    )
    return primary.with_fallbacks([fallback])
