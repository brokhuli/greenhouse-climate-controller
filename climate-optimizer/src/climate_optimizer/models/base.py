"""Shared Pydantic base and wire-level patterns.

Every model mirrors a JSON-Schema wire contract under ``contracts/``. The schemas set
``additionalProperties: false``, so the base forbids extras; ``populate_by_name`` lets the
``PlanningContext.from_`` field bind to the reserved wire key ``from``.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict

# RFC-007 identity slug, shared HH:MM and schedule shapes (mirrors contracts/**/common.json
# and setpoints.schema.json). Kept here so every model references one definition.
SLUG_PATTERN = r"^[a-z0-9]+(-[a-z0-9]+)*$"
HHMM_PATTERN = r"^([01][0-9]|2[0-3]):[0-5][0-9]$"
SCHEDULE_PATTERN = r"^([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9])*$"


class StrictModel(BaseModel):
    """Base for every contract-mirroring model: reject unknown fields, allow field names."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)
