"""The FastAPI operator service (spec 10) — the optimizer's own internal surface."""

from __future__ import annotations

from .app import create_app, main
from .context import (
    ConfigurationError,
    ServiceContext,
    build_context,
    build_health,
    validate_startup,
)

__all__ = [
    "ConfigurationError",
    "ServiceContext",
    "build_context",
    "build_health",
    "create_app",
    "main",
    "validate_startup",
]
