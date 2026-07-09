# Backlog

The central list of deferred and cross-cutting work for the project. Per-artifact follow-ups
still live where they belong — an RFC's **Open Questions**, a spec's **Deferred / Out of
Scope** section — but anything that spans multiple artifacts, or is blocked on infrastructure
the repo does not have yet (e.g. CI), is tracked here so it is not lost in a single document.

Newest entries at the top. When an item is picked up, remove it here and record the outcome in
the relevant ADR / RFC.

| Item | Why | Blocked on / When | Reference |
|---|---|---|---|
| Extend CI: coverage + per-phase gates | The CI pipeline now re-runs the Rust gate and the contract harness on push/PR ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)), but coverage is not yet enforced (`P1-TEST-1`, `cargo llvm-cov`), and the Go, Python, frontend, and load gates are not wired. | Coverage is wireable now; the per-phase gates land with the phase they verify (Phase 2 Go, Phase 3 Python, frontend). | [RFC-010](./decisions/request-for-comments.md#rfc-010-verification--continuous-integration-strategy); [`spec-verification.md §4`](./specs/design/spec-verification.md#4-tooling-matrix), [`§6`](./specs/design/spec-verification.md#6-ci-topology) |

### Notes

**2b observability slice landed (2026-07-05).** Prometheus + Grafana now ship in the Compose stack
(removing the item formerly listed above). The Go `api` exposes **`/metrics`** (`platform_*` — ingestion
rate, API latency/errors, reconciliation actions, per-controller connectivity, and pgx-pool +
TimescaleDB background-job health, incl. the provenance-prune `add_job`). As an additive extension, each
Rust controller exposes its **own** `/metrics` (`controller_*` — tick cadence/compute, MQTT
publish/connection, faults/mode, config applies), scraped as its own source of truth. Prometheus scrapes
the API (static) and the dynamic controller fleet (file-SD emitted by `gen-controllers.sh`); Grafana
auto-provisions *Platform Health* + *Controller Fleet*. The Phase 3 optimizer's `/metrics` is now a
**defined** (no longer optional) surface in its spec, to join the same Prometheus/Grafana when it lands.
Outcome recorded in the [2026-07-05 ADR entry](./decisions/architecture-design-record.md) and
[operations §1](./specs/design/platform/08-spec-platform-operations.md#1-observability).

**CI pipeline scope.** The clean-environment runner is **adopted** (GitHub Actions,
[2026-06-22](./decisions/local-environment-record.md)): it re-runs, on push/PR, the Rust gate
(`fmt`/`clippy`/`check`/`test`) and the contract harness
([`scripts/validate-contracts.mjs`](../scripts/validate-contracts.mjs)) — the same gates the
pre-commit hook fires locally — plus the **Go gate** (`go test` unit + a testcontainers TimescaleDB
integration job) and the **frontend gate** (ESLint/`tsc`/Vitest + blocking Lighthouse CI on the
static production build), both since landed. Still outstanding: Rust coverage against `P1-TEST-1`
(`cargo llvm-cov`), the frontend E2E (Playwright) harness, the load suite, and — with Phase 3 — the
Python gate.

**2b auth slice landed.** Human viewer/operator authentication is implemented (removing the
first item above): Keycloak (`auth`) issues OIDC tokens, the Go API validates them and gates the
nine write endpoints to the operator role, and the SPA performs the Authorization-Code + PKCE login
and disables write affordances for viewers. The stack now runs behind the single nginx `proxy`
(`/`, `/api`, `/auth`). Auth is enforced whenever `PLATFORM_OIDC_ISSUER_URL` is set (always, in the
shipped Compose); an unconfigured local/test run stays open, the 2a trusted-network posture.

**Service-auth hardening landed (2026-07-04).** Both RFC-011 write boundaries are now implemented and
**dormant by default** (removing the item formerly listed above): the Go API gained
`PLATFORM_SERVICE_AUTH_MODE` (`trusted_network` default | `oidc`) gating a new `POST /setpoints`
(`source = optimizer`, `202`) via a `setpoints:write` service role, and the Rust controller enforces an
optional `[api].auth_token` on its REST write endpoints (unset = today's behavior), with the platform
provisioning + presenting the matching token. Keycloak gained the confidential `optimizer` client. Token
*acquisition* by the optimizer is still Phase 3; only the platform/controller sides are built. Outcome
recorded in the [2026-07-04 ADR entry](./decisions/architecture-design-record.md) and
[RFC-011](./decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009).
