"""Phase-2 data-access client (spec 06 §2; contracts #7 read, #3 write).

The optimizer's only up/down channel to the platform: an async httpx client that reads one
greenhouse's planning context and submits refined setpoints. It is decoupled from the platform's
storage — the read is a REST contract (RFC-008). Reads validate the body against the wire schema and
raise a typed ``PlatformError`` carrying a reason code; writes return a ``WriteOutcome`` mapping every
response the setpoint path can return to its canonical outcome + reason code (spec 06 Write outcomes),
so no status is silently unhandled.

Auth is the config-gated service seam (RFC-011): ``trusted_network`` (default) sends the call
untokened; ``oidc`` attaches a ``Bearer`` service token when one is supplied. Acquiring that token
(the Keycloak client-credentials exchange) lands with the service slice; the header wiring is here and
dormant by default.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import TracebackType

import httpx
from jsonschema import ValidationError as SchemaValidationError
from pydantic import ValidationError

from . import schema_validation
from .config import Settings
from .models import PlanningContext, ReasonCode, Setpoints, SetpointsPatch

_DEFAULT_TIMEOUT_SECONDS = 30.0


class PlatformError(Exception):
    """A read-path failure carrying the canonical escalation reason code (spec 06 / interfaces)."""

    def __init__(self, reason_code: ReasonCode, message: str) -> None:
        super().__init__(message)
        self.reason_code = reason_code
        self.message = message


@dataclass(frozen=True)
class WriteOutcome:
    """The outcome of a setpoint submission, mapped from the Phase-2 response (spec 06 Write outcomes)."""

    applied: bool
    reason_code: ReasonCode | None
    message: str
    controller_offline: bool = False
    setpoints: Setpoints | None = None

    @classmethod
    def applied_ok(
        cls, *, setpoints: Setpoints | None, controller_offline: bool = False, message: str
    ) -> WriteOutcome:
        return cls(
            applied=True,
            reason_code=None,
            message=message,
            controller_offline=controller_offline,
            setpoints=setpoints,
        )

    @classmethod
    def escalated(cls, reason_code: ReasonCode, message: str) -> WriteOutcome:
        return cls(applied=False, reason_code=reason_code, message=message)


class PlatformClient:
    """Async client for the Phase-2 read and write paths."""

    def __init__(
        self,
        settings: Settings,
        *,
        client: httpx.AsyncClient | None = None,
        bearer_token: str | None = None,
    ) -> None:
        self._settings = settings
        self._base = settings.data.platform_api_url.rstrip("/")
        self._bearer_token = bearer_token
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT_SECONDS)

    async def __aenter__(self) -> PlatformClient:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    def _auth_headers(self) -> dict[str, str]:
        # RFC-011: only oidc mode carries a token; trusted_network sends nothing.
        if self._settings.platform_auth.mode == "oidc" and self._bearer_token:
            return {"Authorization": f"Bearer {self._bearer_token}"}
        return {}

    async def get_planning_context(
        self, greenhouse_id: str, *, window: str = "12h", interval: str = "1h"
    ) -> PlanningContext:
        """Read one greenhouse's planning context; raise ``PlatformError`` on any non-200."""
        url = f"{self._base}/greenhouses/{greenhouse_id}/planning-context"
        try:
            response = await self._client.get(url, params={"window": window, "interval": interval})
        except (httpx.TimeoutException, httpx.TransportError) as err:
            raise PlatformError(
                ReasonCode.PLATFORM_UNAVAILABLE, f"planning-context read failed: {err}"
            ) from err

        if response.status_code == 404:
            raise PlatformError(
                ReasonCode.CONTRACT_DRIFT, f"greenhouse {greenhouse_id} not found (404)"
            )
        if response.status_code != 200:
            raise PlatformError(
                ReasonCode.PLATFORM_UNAVAILABLE,
                f"planning-context read returned {response.status_code}",
            )

        try:
            payload = response.json()
            schema_validation.validate_planning_context(payload)
            return PlanningContext.model_validate(payload)
        except (SchemaValidationError, ValidationError, ValueError) as err:
            raise PlatformError(
                ReasonCode.CONTRACT_DRIFT, f"planning-context response invalid: {err}"
            ) from err

    async def submit_setpoints(self, greenhouse_id: str, patch: SetpointsPatch) -> WriteOutcome:
        """Submit refined setpoints; map every Phase-2 response to a canonical outcome."""
        url = f"{self._base}/greenhouses/{greenhouse_id}/setpoints"
        body = patch.model_dump(mode="json", exclude_unset=True)
        try:
            response = await self._client.post(url, json=body, headers=self._auth_headers())
        except (httpx.TimeoutException, httpx.TransportError) as err:
            return WriteOutcome.escalated(
                ReasonCode.PLATFORM_UNAVAILABLE, f"setpoint write failed to reach platform: {err}"
            )

        code = response.status_code
        if code == 202:
            setpoints: Setpoints | None = None
            try:
                setpoints = Setpoints.model_validate(response.json())
            except (ValidationError, ValueError):
                setpoints = None
            return WriteOutcome.applied_ok(setpoints=setpoints, message="setpoints accepted (202)")
        if code == 503:
            return WriteOutcome.applied_ok(
                setpoints=None,
                controller_offline=True,
                message="recorded; controller offline (503), re-asserted on reconnect",
            )
        if code == 422:
            return WriteOutcome.escalated(
                ReasonCode.BOUNDS_MISMATCH, f"platform rejected bounds (422): {response.text}"
            )
        if code in (401, 403):
            return WriteOutcome.escalated(
                ReasonCode.WRITE_UNAUTHORIZED, f"write not authorized ({code})"
            )
        if code == 404:
            return WriteOutcome.escalated(
                ReasonCode.CONTRACT_DRIFT, f"greenhouse {greenhouse_id} not found (404)"
            )
        return WriteOutcome.escalated(
            ReasonCode.PLATFORM_UNAVAILABLE, f"unexpected setpoint-write status {code}"
        )
