# Platform — Authentication & Authorization

> **Purpose:** Define **who can do what**: how identity is delegated to a self-hosted
> OIDC provider, how the Go API validates the resulting tokens, how Keycloak roles map
> to the platform's two capability roles, and exactly which role may call which
> surface. The internal-trust model and the 2a "no auth on the local network" stance
> are fixed by
> [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries);
> the relevant quality target is `P2-SEC-1`.

> **Phase 2b.** 2a runs **unauthenticated** on the trusted local Docker network
> (consistent with RFC-009); Keycloak, the viewer/operator roles, and the nginx
> `/auth` route ([architecture §4](./spec-platform-architecture.md#4-reverse-proxy--the-edge))
> all land in 2b. See [§5](#5-the-2a-unauthenticated-stance).

---

## 1. Identity is delegated to Keycloak

Identity is delegated to **Keycloak**, a self-hosted **OIDC identity provider** that
runs as a container in the stack ([operations](./spec-platform-operations.md#2-deployment))
— no cloud dependency. Keycloak owns the user store, login, password policies, and
(optionally) MFA, so the Go API never handles credentials itself.

---

## 2. The authn / authz split

- **Authentication → Keycloak.** Users log in against Keycloak; it issues OIDC tokens.
  The API is an OIDC **relying party** — it validates those tokens and trusts the
  identity + roles they carry.
- **Authorization → the API.** Which role may do what is enforced in the API by
  mapping Keycloak roles onto the platform's two roles
  ([§3](#3-roles-and-role-mapping)). This authorization model is independent of
  Keycloak's internals, so the identity provider and the capability rules evolve
  separately.

### Login & token flow

1. The browser SPA, having no session, redirects to Keycloak via `/auth`
   (**Authorization Code + PKCE** — the public-client flow, no client secret in the
   browser; see [frontend tech stack](../frontend/spec-frontend-tech-stack.md)).
2. The user authenticates against Keycloak; Keycloak redirects back with an
   authorization code, which the SPA exchanges for an **access token** (JWT) and a
   refresh token.
3. The SPA attaches the access token as a `Bearer` credential on every API call.
4. The Go API **validates** the token on each request — signature against Keycloak's
   published JWKS, plus issuer/audience/expiry — then reads the roles claim and applies
   the capability rules below. No per-request round-trip to Keycloak is needed for
   validation.

---

## 3. Roles and role mapping

Two roles are sufficient for the platform:

| Role | Capability |
|---|---|
| Viewer | Read fleet, telemetry, analytics, status |
| Operator | All of Viewer **plus** every write-path action (assign/apply profiles, ad-hoc setpoint edits) |

Keycloak realm roles (e.g. `gh-viewer`, `gh-operator`) are mapped onto these two
platform roles in the API's authorization layer. Keeping the mapping in the API — not
hard-coding Keycloak's role names through the codebase — is what lets the IdP's role
taxonomy change without touching capability logic.

Finer-grained RBAC and multi-tenant identity are out of scope
([constraints](./spec-platform-constraints.md)).

---

## 4. Capability matrix

How the two roles line up against the [API surface](./spec-platform-interfaces.md#3-api-surface-inventory):

| Surface | Viewer | Operator |
|---|---|---|
| Read fleet / per-greenhouse status | ✓ | ✓ |
| Telemetry range queries / analytics | ✓ | ✓ |
| Browse crop-profile library | ✓ | ✓ |
| Register / retire greenhouses | — | ✓ |
| Ad-hoc setpoint edits | — | ✓ |
| Create/edit crop profiles | — | ✓ |
| Assign profile/stage + apply/reconcile | — | ✓ |
| `POST /setpoints` (optimizer write path) | — | ✓ |

The rule reduces to: **viewers read, operators read and write.** Every write surface
is an operator-only action.

---

## 5. The 2a unauthenticated stance

In 2a the platform runs with **no authentication**: every endpoint is open on the
trusted local Docker network, consistent with the internal-trust boundary in
[RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries).
This is deliberate — it keeps the MVP focused on the telemetry pipeline and the
setpoint relay, and adding Keycloak in 2b changes **no committed interface** (the same
write endpoints simply become operator-gated). The frontend's relying-party client is
absent in 2a and added in 2b ([frontend tech stack](../frontend/spec-frontend-tech-stack.md)).

### Known residual risk — the service-to-service plane stays unauthenticated

The authenticated boundary is **human → API/SPA only** (Keycloak, 2b). The
service-to-service plane is unauthenticated *by decision* — and stays that way in 2b,
not only 2a: the controller REST API is unauthenticated and MQTT is anonymous on the
local network
([RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries),
ADR 2026-06-08). The accepted consequence:

- Any process that can reach the Docker network can **spoof a registered
  `greenhouse_id`** — publish false telemetry over MQTT — or call the **controller REST
  setpoint path** / the platform's **`POST /setpoints`** directly.
- Setpoint **provenance** (`source = optimizer`, [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain))
  is therefore **self-asserted by the caller**, not backed by a verified token identity.

This is **accepted within the single-host local threat model**: `P2-SEC-1` commits
*human* authentication only, because service-credential machinery (per-controller tokens,
an optimizer service account) is operational surface disproportionate to a one-host
deployment. The **revisit trigger** is explicit — the controller-endpoint registry
record and the optimizer are the natural seams to add per-service tokens **if the system
ever leaves the single-host local model**.

---

## 6. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Where users / roles are stored | defines | [`spec-platform-data-model.md`](./spec-platform-data-model.md) |
| The `/auth` route + the proxy edge | gated at | [`spec-platform-architecture.md`](./spec-platform-architecture.md#4-reverse-proxy--the-edge) |
| The surfaces these roles gate | gates | [`spec-platform-interfaces.md`](./spec-platform-interfaces.md#3-api-surface-inventory) |
| The browser-side OIDC client | paired with | [frontend tech stack](../frontend/spec-frontend-tech-stack.md) |
| Internal trust boundary; 2a no-auth | defers to | [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries) |
| `P2-SEC-1` | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
