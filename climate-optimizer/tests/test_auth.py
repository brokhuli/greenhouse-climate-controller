"""Service-to-service token acquisition and the inbound operator gate (RFC-011, spec 10)."""

from __future__ import annotations

import httpx
import pytest
import respx

from climate_optimizer.auth import (
    TRUSTED_NETWORK_IDENTITY,
    OperatorAuthError,
    OperatorIdentity,
    TokenAcquisitionError,
    TokenProvider,
    authorize_operator,
)
from climate_optimizer.config import Settings

TOKEN_URL = "https://auth.local/realms/greenhouse/protocol/openid-connect/token"


def _oidc_settings(**overrides: str) -> Settings:
    platform_auth: dict[str, str] = {
        "mode": "oidc",
        "oidc_token_url": TOKEN_URL,
        "oidc_client_id": "optimizer",
    }
    platform_auth.update(overrides)
    return Settings(platform_auth=platform_auth)


class _Verifier:
    """A stand-in for the JWKS-backed verifier: the gate's logic, not PyJWT's."""

    def __init__(self, identity: OperatorIdentity | None = None, error: Exception | None = None):
        self.identity = identity or OperatorIdentity(subject="alice", roles=frozenset({"operator"}))
        self.error = error

    def verify(self, token: str) -> OperatorIdentity:
        if self.error is not None:
            raise self.error
        return self.identity


# -- outbound: the Phase-2 write-path token ---------------------------------


async def test_trusted_network_needs_no_token() -> None:
    provider = TokenProvider(Settings())
    assert provider.enabled is False
    assert await provider.token() is None
    await provider.aclose()


@respx.mock
async def test_oidc_mode_fetches_a_client_credentials_token() -> None:
    route = respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"access_token": "tok-1", "expires_in": 300})
    )
    provider = TokenProvider(_oidc_settings())

    assert await provider.token() == "tok-1"
    assert route.call_count == 1
    request_body = route.calls.last.request.content.decode()
    assert "grant_type=client_credentials" in request_body
    assert "client_id=optimizer" in request_body
    await provider.aclose()


@respx.mock
async def test_token_is_cached_until_it_nears_expiry() -> None:
    route = respx.post(TOKEN_URL).mock(
        return_value=httpx.Response(200, json={"access_token": "tok-1", "expires_in": 300})
    )
    provider = TokenProvider(_oidc_settings())

    await provider.token()
    await provider.token()

    assert route.call_count == 1
    await provider.aclose()


@respx.mock
async def test_short_lived_token_is_refetched() -> None:
    route = respx.post(TOKEN_URL).mock(
        # expires_in below the refresh margin means the cache is never considered valid.
        return_value=httpx.Response(200, json={"access_token": "tok-1", "expires_in": 1})
    )
    provider = TokenProvider(_oidc_settings())

    await provider.token()
    await provider.token()

    assert route.call_count == 2
    await provider.aclose()


@respx.mock
async def test_token_endpoint_failure_raises() -> None:
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(401, text="bad secret"))
    provider = TokenProvider(_oidc_settings())

    with pytest.raises(TokenAcquisitionError) as err:
        await provider.token()

    # The response body can carry credential detail, so it must never be echoed (P3-SEC-1).
    assert "bad secret" not in str(err.value)
    await provider.aclose()


@respx.mock
async def test_token_endpoint_transport_error_raises() -> None:
    respx.post(TOKEN_URL).mock(side_effect=httpx.ConnectError("refused"))
    provider = TokenProvider(_oidc_settings())

    with pytest.raises(TokenAcquisitionError):
        await provider.token()
    await provider.aclose()


@respx.mock
async def test_malformed_token_response_raises() -> None:
    respx.post(TOKEN_URL).mock(return_value=httpx.Response(200, json={"nope": 1}))
    provider = TokenProvider(_oidc_settings())

    with pytest.raises(TokenAcquisitionError):
        await provider.token()
    await provider.aclose()


# -- inbound: the operator gate ---------------------------------------------


def test_trusted_network_allows_untokened_operator_calls() -> None:
    identity = authorize_operator(Settings(), authorization=None, verifier=None)
    assert identity == TRUSTED_NETWORK_IDENTITY


def test_oidc_requires_a_bearer_token() -> None:
    with pytest.raises(OperatorAuthError) as err:
        authorize_operator(_oidc_settings(), authorization=None, verifier=_Verifier())
    assert err.value.status_code == 401


def test_oidc_rejects_a_non_bearer_scheme() -> None:
    with pytest.raises(OperatorAuthError) as err:
        authorize_operator(_oidc_settings(), authorization="Basic abc", verifier=_Verifier())
    assert err.value.status_code == 401


def test_oidc_without_a_configured_verifier_is_unauthorized() -> None:
    with pytest.raises(OperatorAuthError) as err:
        authorize_operator(_oidc_settings(), authorization="Bearer t", verifier=None)
    assert err.value.status_code == 401


def test_oidc_accepts_a_token_carrying_the_operator_role() -> None:
    identity = authorize_operator(_oidc_settings(), authorization="Bearer t", verifier=_Verifier())
    assert identity.subject == "alice"


def test_oidc_rejects_a_valid_token_without_the_operator_role() -> None:
    viewer = _Verifier(OperatorIdentity(subject="bob", roles=frozenset({"viewer"})))

    with pytest.raises(OperatorAuthError) as err:
        authorize_operator(_oidc_settings(), authorization="Bearer t", verifier=viewer)

    # Authenticated but not authorized — the narrow service role must not unlock operator writes.
    assert err.value.status_code == 403


def test_invalid_token_propagates_as_401() -> None:
    broken = _Verifier(error=OperatorAuthError(401, "expired"))
    with pytest.raises(OperatorAuthError) as err:
        authorize_operator(_oidc_settings(), authorization="Bearer t", verifier=broken)
    assert err.value.status_code == 401
