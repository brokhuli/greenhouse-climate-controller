"""FastAPI dependencies — component access and the operator gate (spec 10).

The mutating endpoints (``POST …/cycles``, ``…/escalations/{id}/resolve``, ``…/model``,
``…/enabled``) are **operator writes**, gated together and separately from the outbound
``setpoints:write`` service seam: choosing a model or pausing planning is an operator decision, not
something a compromised service credential should be able to do.

Under the default ``trusted_network`` posture the calls are untokened like the rest of the
single-host local surface and are attributed to a trusted-network identity; under ``oidc`` a Keycloak
token carrying the operator role is required. Either way the resolved identity is returned so the
route can structured-log *who* made the change alongside their supplied reason.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request

from ..auth import OperatorAuthError, OperatorIdentity, authorize_operator
from .context import ServiceContext


def get_context(request: Request) -> ServiceContext:
    """The wired service components, attached to the app during lifespan startup."""
    context: ServiceContext = request.app.state.context
    return context


Context = Annotated[ServiceContext, Depends(get_context)]


def require_operator(
    ctx: Context,
    authorization: Annotated[str | None, Header()] = None,
) -> OperatorIdentity:
    """Gate an operator-mutating call, translating auth failures to 401/403."""
    try:
        return authorize_operator(ctx.settings, authorization=authorization, verifier=ctx.verifier)
    except OperatorAuthError as err:
        raise HTTPException(status_code=err.status_code, detail=err.detail) from err


Operator = Annotated[OperatorIdentity, Depends(require_operator)]
