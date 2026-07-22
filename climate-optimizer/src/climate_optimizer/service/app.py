"""The FastAPI application factory (specs 09, 10, 12).

Startup order matters and follows spec 09: configuration is validated **first** so an invalid config
blocks the service from coming up, then the components are wired, then the background loops start.
Shutdown cancels the loops and closes the HTTP clients.

``create_app`` accepts a pre-built :class:`~climate_optimizer.service.context.ServiceContext` so tests
can inject a fake planner and a mocked platform, and ``start_scheduler=False`` so they can exercise
the routes without a live cadence running underneath them.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from ..config import Settings, load_settings
from ..logging import configure_logging
from .context import ServiceContext, build_context, validate_startup
from .routes import router

logger = logging.getLogger(__name__)


def create_app(
    settings: Settings | None = None,
    *,
    context: ServiceContext | None = None,
    start_scheduler: bool = True,
) -> FastAPI:
    """Build the optimizer service application."""
    if context is None:
        resolved = settings or load_settings()
        validate_startup(resolved)
        context = build_context(resolved)

    service_context = context

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.context = service_context
        if start_scheduler:
            service_context.scheduler.start()
            logger.info(
                "optimizer service started",
                extra={
                    "event": "optimizer_service_started",
                    "enabled": service_context.runtime.enabled.enabled,
                    "provider": service_context.runtime.provider.value,
                    "model": service_context.runtime.model,
                    "prompt_version": service_context.settings.llm.prompt_version,
                    "cadence_minutes": (service_context.settings.planning.cycle_interval_minutes),
                },
            )
        try:
            yield
        finally:
            await service_context.aclose()

    app = FastAPI(
        title="climate-optimizer",
        summary="Phase 3 optimizer Service API (internal, unversioned).",
        lifespan=lifespan,
    )
    app.state.context = service_context
    app.include_router(router)
    return app


def main() -> None:
    """Console entrypoint: validate config, then serve (spec 12 §Deployment)."""
    import uvicorn

    configure_logging()
    settings = load_settings()
    validate_startup(settings)
    uvicorn.run(create_app(settings), host="0.0.0.0", port=8000)  # noqa: S104
