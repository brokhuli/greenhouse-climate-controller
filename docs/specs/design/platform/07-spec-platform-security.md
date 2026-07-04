# Platform — Authentication & Authorization

> **Purpose:** Define **who can do what**: how identity is delegated to a self-hosted
> OIDC provider, how the Go API validates the resulting tokens, how Keycloak roles map
> to the platform's two capability roles, and exactly which role may call which
> surface. The internal-trust model is fixed by
> [RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)
> (which **supersedes** [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)):
> human auth is always-on in 2b, and the two internal **service** write boundaries gain authentication
> as a **config-gated mode that is off by default** in the single-host local deployment ([§5](#5-the-2a-unauthenticated-stance--and-the-deferred-service-auth-mode)).
> The relevant quality target is `P2-SEC-1`.

> **Phase 2b.** 2a runs **unauthenticated** on the trusted local Docker network; Keycloak, the
> viewer/operator roles, and the nginx `/auth` route
> ([architecture §4](./02-spec-platform-architecture.md#4-reverse-proxy--the-edge)) all land in 2b. The
> optional **service-auth** mode (`SERVICE_AUTH_MODE=oidc`, [§5](#5-the-2a-unauthenticated-stance--and-the-deferred-service-auth-mode))
> is a further 2b capability, dormant by default. See [§5](#5-the-2a-unauthenticated-stance--and-the-deferred-service-auth-mode).

---

## 1. Identity is delegated to Keycloak

Identity is delegated to **Keycloak**, a self-hosted **OIDC identity provider** that
runs as a container in the stack ([operations](./08-spec-platform-operations.md#2-deployment))
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

**Reads need no login.** Anonymous visitors get read-only viewer access — the SPA loads the
fleet, dashboards, and live telemetry without a session, and the API serves reads without a
token. Login is required only to gain the **operator** (write) role. So the flow below is
triggered when a visitor chooses to sign in (or a write is attempted), not on first access.

1. When the visitor signs in, the browser SPA redirects to Keycloak via `/auth`
   (**Authorization Code + PKCE** — the public-client flow, no client secret in the
   browser; see [frontend tech stack](../frontend/04-spec-frontend-tech-stack.md)).
2. The user authenticates against Keycloak; Keycloak redirects back with an
   authorization code, which the SPA exchanges for an **access token** (JWT) and a
   refresh token.
3. The SPA attaches the access token as a `Bearer` credential on every API call.
4. The Go API **validates** the token when one is present — signature against Keycloak's
   published JWKS, plus issuer/audience/expiry — then reads the roles claim and applies
   the capability rules below. A request with **no** token is served as an anonymous viewer
   (reads only); a request with a **present-but-invalid** token is rejected (401). No
   per-request round-trip to Keycloak is needed for validation.

---

## 3. Roles and role mapping

Two roles are sufficient for the platform:

| Role | Capability |
|---|---|
| Viewer | Read fleet, telemetry, analytics, status |
| Operator | All of Viewer **plus** every write-path action (assign/apply profiles, ad-hoc setpoint edits) |

The **viewer** capability is the public baseline: it is granted to any request, with or
without a token, so dashboards and telemetry are open to anyone. Signing in as a Keycloak
`gh-viewer` user is therefore an *optional* named read-only identity, not a prerequisite to
read — what login actually buys is the **operator** role and its write access.

Keycloak realm roles (e.g. `gh-viewer`, `gh-operator`) are mapped onto these two
platform roles in the API's authorization layer. Keeping the mapping in the API — not
hard-coding Keycloak's role names through the codebase — is what lets the IdP's role
taxonomy change without touching capability logic.

### Two actor types: human and service

The viewer/operator roles above describe **human** actors. When the deferred service-auth mode is
enabled ([§5](#5-the-2a-unauthenticated-stance--and-the-deferred-service-auth-mode),
[RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)),
a second actor type appears: a **service** identity — the optimizer — that authenticates with a Keycloak
**client-credentials** token instead of a browser login. It is deliberately *not* mapped to the operator
role; it carries a **narrow `setpoints:write` service role** whose only capability is submitting setpoint
proposals (operators also assign profiles and register greenhouses, which the optimizer never does — so
giving it the operator role would over-grant). Both actor types are validated through the **same**
token path ([§2](#2-the-authn--authz-split)); they differ only in the grant that minted the token
(Authorization Code + PKCE for humans, client-credentials for the service) and the claims the API reads.

Finer-grained RBAC and multi-tenant identity are out of scope
([constraints](./11-spec-platform-constraints.md)).

---

## 4. Capability matrix

How the roles line up against the [API surface](./09-spec-platform-interfaces.md#3-api-surface-inventory).
The **Anonymous** column is a caller with no token; it holds the viewer capability:

| Surface | Anonymous | Viewer | Operator |
|---|---|---|---|
| Read fleet / per-greenhouse status | ✓ | ✓ | ✓ |
| Telemetry range queries / analytics | ✓ | ✓ | ✓ |
| Live telemetry stream (WebSocket) | ✓ | ✓ | ✓ |
| Browse crop-profile library | ✓ | ✓ | ✓ |
| Register / retire greenhouses | — | — | ✓ |
| Ad-hoc setpoint edits | — | — | ✓ |
| Create/edit crop profiles | — | — | ✓ |
| Assign profile/stage + apply/reconcile | — | — | ✓ |
| `POST /setpoints` (optimizer write path) | — | — | ✓ |

The rule reduces to: **anyone reads, operators read and write.** A write attempted with no
token is answered 401 (sign in); with a non-operator token, 403. Every write surface
is an operator-only action **for human actors**. The `POST /setpoints` row is the one surface a
**service** actor also reaches: in `SERVICE_AUTH_MODE=oidc` the optimizer calls it with the narrow
`setpoints:write` role ([§3](#two-actor-types-human-and-service)) — it cannot touch any other write
surface (registration, profiles, assignments), which remain operator-only.

---

## 5. The 2a unauthenticated stance — and the deferred service-auth mode

In 2a the platform runs with **no authentication**: every endpoint is open on the
trusted local Docker network. This is deliberate — it keeps the MVP focused on the
telemetry pipeline and the setpoint relay, and adding Keycloak in 2b changes **no
committed interface**: reads stay open to anyone (now as an explicit anonymous-viewer
posture rather than trusted-network happenstance), and only the write endpoints become
operator-gated. The frontend's relying-party client is absent in 2a and added in 2b
([frontend tech stack](../frontend/04-spec-frontend-tech-stack.md)).

### The service-to-service plane: trusted by default, authenticatable on demand

Per [RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)
(which supersedes [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)),
the two internal **write** boundaries are **trusted on the Docker network by default**, but each gains an
**opt-in** authentication mechanism so the system can be hardened for a cloud / multi-host deployment
**without changing any committed interface**:

| Boundary | Default (single-host local) | Hardened mode | Selector |
|---|---|---|---|
| Optimizer → Phase 2 `POST /setpoints` | accepted untokened | requires a Keycloak `setpoints:write` client-credentials token ([§3](#two-actor-types-human-and-service)) | `SERVICE_AUTH_MODE=trusted_network` \| `oidc` |
| Platform → controller REST writes | accepted untokened | requires a per-controller pre-shared bearer token ([controller interfaces §3](../controller/08-spec-controller-interfaces.md#3-rest--the-sole-write-path)) | controller token set / unset |

`SERVICE_AUTH_MODE` is a Phase 2 API config value
([operations — deployment](./08-spec-platform-operations.md#2-deployment)); the controller token is an
optional TOML field whose **presence** turns the check on
([controller config](../controller/07-spec-controller-config-and-parameters.md)). MQTT stays anonymous
and telemetry-only regardless ([RFC-001](../../../decisions/request-for-comments.md#rfc-001-mqtt-broker-selection)) —
it carries no command authority, so it is not a write boundary.

### Residual risk in the default (`trusted_network`) posture

With both switches off — the committed single-host default — the accepted consequence is unchanged from
the prior posture:

- Any process that can reach the Docker network can **spoof a registered `greenhouse_id`** (publish
  false telemetry over MQTT) or call the **controller REST setpoint path** / the platform's
  **`POST /setpoints`** directly.
- Setpoint **provenance** (`source = optimizer`, [RFC-005](../../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain))
  is **self-asserted by the caller**, not backed by a verified token identity.

This is **accepted within the single-host local threat model** (`P2-SEC-1` commits *human* authentication
as the always-on boundary; service-credential machinery is disproportionate operational surface for a
one-host deployment). What [RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)
changes from RFC-009 is that the mitigation is **already specified and wired as a dormant mode**: enabling
`SERVICE_AUTH_MODE=oidc` and provisioning controller tokens **closes** this gap — the optimizer's
provenance becomes identity-backed and the controller's only inbound write path becomes
platform-authenticated — the instant a deployment leaves the single-host model, with no interface change.

---

## 6. Cross-spec map

| Concern | This spec | Detailed in |
|---|---|---|
| Where users / roles are stored | defines | [`03-spec-platform-data-model.md`](./03-spec-platform-data-model.md) |
| The `/auth` route + the proxy edge | gated at | [`02-spec-platform-architecture.md`](./02-spec-platform-architecture.md#4-reverse-proxy--the-edge) |
| The surfaces these roles gate | gates | [`09-spec-platform-interfaces.md`](./09-spec-platform-interfaces.md#3-api-surface-inventory) |
| The browser-side OIDC client | paired with | [frontend tech stack](../frontend/04-spec-frontend-tech-stack.md) |
| Internal trust boundary; service-auth mode | defers to | [RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009) (supersedes [RFC-009](../../../decisions/request-for-comments.md#rfc-009-service-to-service-auth--internal-trust-boundaries)) |
| `SERVICE_AUTH_MODE` config value | set in | [`08-spec-platform-operations.md`](./08-spec-platform-operations.md#2-deployment) |
| `P2-SEC-1` | cited | [NFR doc](../../artifacts/non-functional-requirements.md) |
