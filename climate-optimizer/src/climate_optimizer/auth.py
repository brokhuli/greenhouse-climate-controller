"""Service-to-service and operator authentication (spec 10, RFC-011).

Two independent seams, both dormant under the default ``trusted_network`` posture and both switched
on by ``platform_auth.mode = oidc``:

**Outbound** — :class:`TokenProvider` acquires the Keycloak *client-credentials* token the Phase-2
setpoint write presents as a ``Bearer`` credential. It carries the narrow ``setpoints:write`` service
role, not the operator role, so a compromised credential can do nothing but propose in-bounds
setpoints that Phase 2 re-validates regardless. The token is cached until shortly before expiry.

**Inbound** — :class:`JwtOperatorVerifier` verifies the token an operator presents on the mutating
Service API endpoints (``POST …/cycles``, ``…/escalations/{id}/resolve``, ``…/model``,
``…/enabled``), requiring the **operator** role. This is a different credential from the outbound
service token, deliberately: choosing a model or pausing planning is an operator decision.

The client secret comes from ``PLANNER_OIDC_CLIENT_SECRET`` (env only) and is never logged (P3-SEC-1).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx
import jwt
from jwt import PyJWKClient

from .config import Settings

logger = logging.getLogger(__name__)

# Refresh a little before the token actually expires so an in-flight write never races the clock.
_EXPIRY_MARGIN_SECONDS = 30.0
_TOKEN_TIMEOUT_SECONDS = 15.0


class TokenAcquisitionError(Exception):
    """The client-credentials exchange failed; the caller escalates ``write_unauthorized``."""


class TokenProvider:
    """Caching Keycloak client-credentials token source for the Phase-2 write path (RFC-011)."""

    def __init__(self, settings: Settings, *, client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(timeout=_TOKEN_TIMEOUT_SECONDS)
        self._token: str | None = None
        self._expires_at: float = 0.0

    @property
    def enabled(self) -> bool:
        """Whether the outbound seam is active at all (``oidc`` posture only)."""
        return self._settings.platform_auth.mode == "oidc"

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def token(self) -> str | None:
        """A valid bearer token, or ``None`` under ``trusted_network`` (the call goes untokened)."""
        if not self.enabled:
            return None
        if self._token is not None and time.monotonic() < self._expires_at:
            return self._token
        return await self._fetch()

    async def _fetch(self) -> str:
        auth = self._settings.platform_auth
        secret = self._settings.planner_oidc_client_secret.get_secret_value()
        try:
            response = await self._client.post(
                auth.oidc_token_url,
                data={
                    "grant_type": "client_credentials",
                    "client_id": auth.oidc_client_id,
                    "client_secret": secret,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
        except (httpx.TimeoutException, httpx.TransportError) as err:
            raise TokenAcquisitionError(f"token endpoint unreachable: {err}") from err

        if response.status_code != 200:
            # Never echo the body: it can carry credential detail (P3-SEC-1).
            raise TokenAcquisitionError(f"token endpoint returned {response.status_code}")

        try:
            payload = response.json()
            token = str(payload["access_token"])
            expires_in = float(payload.get("expires_in", 60.0))
        except (KeyError, TypeError, ValueError) as err:
            raise TokenAcquisitionError("token response missing access_token") from err

        self._token = token
        self._expires_at = time.monotonic() + max(expires_in - _EXPIRY_MARGIN_SECONDS, 0.0)
        logger.info(
            "acquired platform service token",
            extra={"event": "optimizer_service_token_acquired", "expires_in": expires_in},
        )
        return token


@dataclass(frozen=True)
class OperatorIdentity:
    """Who made an operator-gated call, for the structured audit trail (spec 10)."""

    subject: str
    roles: frozenset[str] = field(default_factory=frozenset)

    @property
    def label(self) -> str:
        return self.subject


# The identity attributed to untokened calls on the trusted local network.
TRUSTED_NETWORK_IDENTITY = OperatorIdentity(subject="trusted-network")


class OperatorAuthError(Exception):
    """Inbound operator auth failed; ``status_code`` is 401 (no/invalid token) or 403 (no role)."""

    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class OperatorVerifier(Protocol):
    """Verifies a bearer token and returns the caller's identity (injectable for tests)."""

    def verify(self, token: str) -> OperatorIdentity: ...


def _keycloak_roles(claims: dict[str, Any]) -> frozenset[str]:
    """Collect realm and per-client roles from a Keycloak access token."""
    roles: set[str] = set()
    realm_access = claims.get("realm_access")
    if isinstance(realm_access, dict):
        roles.update(str(r) for r in realm_access.get("roles", []))
    resource_access = claims.get("resource_access")
    if isinstance(resource_access, dict):
        for entry in resource_access.values():
            if isinstance(entry, dict):
                roles.update(str(r) for r in entry.get("roles", []))
    return frozenset(roles)


class JwtOperatorVerifier:
    """Verifies Keycloak-issued RS256 access tokens against the realm's JWKS."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings.operator_auth
        self._jwks = PyJWKClient(self._settings.jwks_url) if self._settings.jwks_url else None

    def verify(self, token: str) -> OperatorIdentity:
        if self._jwks is None:
            raise OperatorAuthError(401, "operator auth is not configured (no jwks_url)")
        try:
            signing_key = self._jwks.get_signing_key_from_jwt(token)
            claims: dict[str, Any] = jwt.decode(
                token,
                signing_key.key,
                algorithms=["RS256"],
                audience=self._settings.audience or None,
                issuer=self._settings.issuer or None,
                options={"verify_aud": bool(self._settings.audience)},
            )
        except (jwt.PyJWTError, ValueError) as err:
            raise OperatorAuthError(401, f"invalid operator token: {err}") from err

        subject = str(claims.get("preferred_username") or claims.get("sub") or "unknown")
        return OperatorIdentity(subject=subject, roles=_keycloak_roles(claims))


def authorize_operator(
    settings: Settings,
    *,
    authorization: str | None,
    verifier: OperatorVerifier | None,
) -> OperatorIdentity:
    """Gate one operator-mutating call.

    Under ``trusted_network`` the call is untokened like the rest of the single-host local surface
    and is attributed to :data:`TRUSTED_NETWORK_IDENTITY`. Under ``oidc`` a valid bearer token
    carrying the configured operator role is required (401 without a usable token, 403 without the
    role) — spec 10 §Authenticating the model-change / enable-disable endpoints.
    """
    if settings.platform_auth.mode != "oidc":
        return TRUSTED_NETWORK_IDENTITY

    if verifier is None:
        raise OperatorAuthError(401, "operator auth is not configured")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise OperatorAuthError(401, "missing bearer token")

    identity = verifier.verify(authorization.split(" ", 1)[1].strip())
    required = settings.operator_auth.role
    if required not in identity.roles:
        raise OperatorAuthError(403, f"operator role {required!r} required")
    return identity
