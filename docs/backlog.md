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

**CI pipeline scope.** The clean-environment runner is **adopted** (GitHub Actions,
[2026-06-22](./decisions/local-environment-record.md)): it re-runs, on push/PR, the Rust gate
(`fmt`/`clippy`/`check`/`test`) and the contract harness
([`scripts/validate-contracts.mjs`](../scripts/validate-contracts.mjs)) — the same gates the
pre-commit hook fires locally. Still outstanding: Rust coverage against `P1-TEST-1`
(`cargo llvm-cov`) and — as each phase lands — the Go, Python, and frontend gates and the load suite.
