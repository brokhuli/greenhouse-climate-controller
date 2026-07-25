"""Structured JSON logging (spec 12 §Observability).

Stdlib ``logging`` with a JSON formatter — no extra dependency, and it mirrors the platform's
``slog`` stream so the whole fleet emits one shape. Each cycle logs a record carrying
``optimizer_run_id``, the input-gate / twin outcome, and whether the plan was applied or escalated,
which is what makes every plan traceable to its cycle (P3-OBS-1).

Anything passed through ``logging``'s ``extra=`` lands as a top-level JSON field, so call sites read
naturally: ``logger.info("...", extra={"optimizer_run_id": ..., "greenhouse_id": ...})``. Secrets are
never logged (P3-SEC-1) — the two ``PLANNER_*`` values are ``SecretStr`` and never passed here.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

# Attributes the stdlib puts on every record; anything else came from a call site's ``extra=``.
_STANDARD_ATTRS = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)


class JsonFormatter(logging.Formatter):
    """Render a log record as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _STANDARD_ATTRS and not key.startswith("_"):
                payload[key] = value
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    """Install the JSON handler on the root logger (idempotent)."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())

    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level.upper())
