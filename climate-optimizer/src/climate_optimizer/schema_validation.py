"""Offline JSON-Schema validation against the shared ``contracts/`` (spec 12: contract validation).

The optimizer *consumes* the wire contracts rather than redefining them, so the raw dicts it
reads (a ``PlanningContext``) and the structured plan it emits are validated against the very
same JSON-Schema 2020-12 documents the Node harness and the other services validate against — a
guard at the boundary, with the Pydantic model as the typed mirror, not a second source of truth.

A ``referencing.Registry`` resolves every ``$id`` and relative ``$ref`` **offline** (no network),
matching the rest of the stack's no-network validation posture.
"""

from __future__ import annotations

import json
import os
from functools import cache, lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

# Base URIs for the OpenAPI component files, which — unlike the optimizer-internal schemas — carry
# no ``$id`` and cross-reference by relative path (``./common.json#/Metric``). Registering them under
# sibling URIs makes those relative refs resolve.
_PLANNING_BASE = (
    "https://greenhouse.local/contracts/platform-optimizer-planning-rest/components/schemas/"
)
PLANNING_CONTEXT_REF = _PLANNING_BASE + "planning-context.json#/PlanningContext"

# The optimizer-internal schemas reference each other by their absolute ``$id`` (read from file).
_INTERNAL_BASE = "https://greenhouse.local/contracts/optimizer-internal-plan-schema/"
OPTIMIZER_PLAN_REF = _INTERNAL_BASE + "optimizer-plan.schema.json"
PLAN_RECORD_REF = _INTERNAL_BASE + "plan-record.schema.json"


def _contracts_dir() -> Path:
    """Locate the repo's ``contracts/`` dir (env override, else repo-relative to this package)."""
    override = os.environ.get("CLIMATE_OPTIMIZER_CONTRACTS_DIR")
    if override:
        return Path(override)
    # src/climate_optimizer/schema_validation.py -> climate_optimizer -> src -> climate-optimizer -> root
    return Path(__file__).resolve().parents[3] / "contracts"


def _load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _registry() -> Registry[Any]:
    """Build the offline schema registry once, keyed by ``$id`` / assigned base URIs."""
    contracts = _contracts_dir()
    internal = contracts / "optimizer-internal-plan-schema"
    planning = contracts / "platform-optimizer-planning-rest" / "components" / "schemas"

    resources: list[tuple[str, Resource[Any]]] = []

    # Optimizer-internal schemas: register under their own $id so cross-refs by $id resolve.
    for name in ("optimizer-plan.schema.json", "plan-record.schema.json", "setpoints.schema.json"):
        contents = _load(internal / name)
        resources.append((contents["$id"], Resource.from_contents(contents)))

    # OpenAPI component files: no $id; assign sibling URIs so ``./common.json`` resolves.
    for name in ("planning-context.json", "common.json"):
        contents = _load(planning / name)
        resource = Resource.from_contents(contents, default_specification=DRAFT202012)
        resources.append((_PLANNING_BASE + name, resource))

    return Registry().with_resources(resources)


@cache
def _validator(ref: str) -> Draft202012Validator:
    return Draft202012Validator({"$ref": ref}, registry=_registry())


def validate_ref(instance: Any, ref: str) -> None:
    """Validate ``instance`` against the schema at ``ref``; raise ``jsonschema.ValidationError``."""
    _validator(ref).validate(instance)


def is_valid(instance: Any, ref: str) -> bool:
    """Return whether ``instance`` satisfies the schema at ``ref`` (no exception)."""
    return _validator(ref).is_valid(instance)


def validate_planning_context(instance: Any) -> None:
    """Validate a raw planning-context read against the wire contract."""
    validate_ref(instance, PLANNING_CONTEXT_REF)


def validate_optimizer_plan(instance: Any) -> None:
    """Validate a raw ``OptimizerPlan`` (the LLM's structured output) against the wire contract."""
    validate_ref(instance, OPTIMIZER_PLAN_REF)


def validate_plan_record(instance: Any) -> None:
    """Validate a raw ``PlanRecord`` envelope against the wire contract."""
    validate_ref(instance, PLAN_RECORD_REF)
