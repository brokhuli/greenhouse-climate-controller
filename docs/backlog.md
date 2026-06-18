# Backlog

The central list of deferred and cross-cutting work for the project. Per-artifact follow-ups
still live where they belong — an RFC's **Open Questions**, a spec's **Deferred / Out of
Scope** section — but anything that spans multiple artifacts, or is blocked on infrastructure
the repo does not have yet (e.g. CI), is tracked here so it is not lost in a single document.

Newest entries at the top. When an item is picked up, remove it here and record the outcome in
the relevant ADR / RFC.

| Item | Why | Blocked on / When | Reference |
|---|---|---|---|
| Stand up a CI pipeline (clean-environment gate) | The verification gates exist but run only locally — the pre-commit Rust gate and the contract harness (`npm run validate:contracts`) fire on a developer's machine, gated by staged paths. Nothing re-runs them in a clean environment on push/PR, and there is no coverage enforcement (`P1-TEST-1`). | When a CI platform is adopted — there is no CI in the repo yet. | [RFC-010](./decisions/request-for-comments.md#rfc-010-verification--continuous-integration-strategy); [`spec-verification.md §6`](./specs/design/spec-verification.md#6-ci-topology-plan-of-record-deferred) |

### Notes

**CI pipeline scope.** When a CI platform lands it re-runs, in a clean environment on push/PR, the
gates already defined: the Rust gate (`fmt`/`clippy`/`check`/`test`), the contract harness
([`scripts/validate-contracts.mjs`](../scripts/validate-contracts.mjs)), Rust coverage against
`P1-TEST-1` (`cargo llvm-cov`), and — as each phase lands — the Go, Python, and frontend gates and the
load suite. The contract harness itself is **done** ([RFC-010](./decisions/request-for-comments.md#rfc-010-verification--continuous-integration-strategy),
[local-environment-record 2026-06-18](./decisions/local-environment-record.md)); only the
clean-environment runner is outstanding.
