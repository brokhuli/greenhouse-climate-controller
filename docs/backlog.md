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
| Enforce auth/role gating on the 2b API surface | The 2b backbone (crop profiles, assignment, sticky setpoints, reconciliation) shipped, but its endpoints declare `bearerAuth` + `401`/`403` in the contract yet run **unauthenticated** — no role gating, matching the 2a trusted-network posture. The `viewer`/`operator` distinction is a no-op until Keycloak lands. | With the deferred **2b auth slice** (Keycloak OIDC + nginx `/auth` + frontend login/token). Until then the 2b surface must stay on the trusted Docker network only. | [platform security §3–4](./specs/design/platform/07-spec-platform-security.md); [platform overview §2](./specs/design/platform/01-spec-platform-overview.md) |
| Ship the remaining 2b infra: observability | The 2b backbone landed without Prometheus/Grafana. The Go API does not yet expose `/metrics`, so ingestion rate, API latency, reconciliation actions, and datastore/background-job health (incl. the provenance-prune `add_job` registered by `EnsureProvenancePrune`) are not yet scraped or dashboarded. | With the deferred **2b observability slice**. | [platform operations §1–2](./specs/design/platform/08-spec-platform-operations.md) |

### Notes

**CI pipeline scope.** The clean-environment runner is **adopted** (GitHub Actions,
[2026-06-22](./decisions/local-environment-record.md)): it re-runs, on push/PR, the Rust gate
(`fmt`/`clippy`/`check`/`test`) and the contract harness
([`scripts/validate-contracts.mjs`](../scripts/validate-contracts.mjs)) — the same gates the
pre-commit hook fires locally. Still outstanding: Rust coverage against `P1-TEST-1`
(`cargo llvm-cov`) and — as each phase lands — the Go, Python, and frontend gates and the load suite.
