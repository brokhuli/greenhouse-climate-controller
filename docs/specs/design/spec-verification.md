# Verification & Feedback Loops (Spec)

How the system is **proven correct** and **kept correct** — the system-wide verification strategy
that the per-phase quality *targets* and per-component verification *docs* hang from. This is the
cross-cutting companion to [`spec-conventions.md`](./spec-conventions.md) (the shared authoring
rules) and [`spec-contracts.md`](./spec-contracts.md) (the cross-component contract catalog): every
spec set's verification section links here rather than restating the ladders, the tooling matrix, or
the CI plan.

> **Reference, don't redefine.** This document owns the *strategy and tooling*. It does **not** own
> the numeric targets — those are the `*-TEST-*` / `*-PERF-*` / `*-REL-*` IDs in the
> [NFR doc](../artifacts/non-functional-requirements.md) — nor the wire formats it checks, which live
> in [`contracts/`](../../../contracts/). A component's *own* verification detail (its scenario
> library, its module test plan) lives in that component's set; the optimizer's
> [`07-spec-optimizer-evaluation.md`](./optimizer/07-spec-optimizer-evaluation.md) and the
> controller's [`11-spec-controller-verification.md`](./controller/11-spec-controller-verification.md)
> are the per-component instances of this strategy.

---

## 1. Two kinds of "feedback loop"

This is a control-systems project, so the term is overloaded. They are kept distinct throughout:

- **The control feedback loop** — sensor → fusion → PID/rule → actuator → plant, closed every tick.
  This is a **runtime domain** concept, owned by
  [control loops](./controller/05-spec-controller-control-loops.md); it is the thing *under test*,
  not a means of testing.
- **Development feedback loops** — the loops that tell an engineer whether a change is correct, from
  the editor keystroke out to a clean-environment run. These are the subject of §3.

Everything below means the development sense unless it says "control loop."

---

## 2. The verification ladder

What "verified" means, rung by rung — cheapest/fastest at the top. Each rung cites the targets it
discharges; the targets themselves stay in the [NFR doc](../artifacts/non-functional-requirements.md).

| Rung | What it proves | Anchored by |
|---|---|---|
| **Static gates** — format, lint, typecheck | Compiles, idiomatic, lint-clean | CLAUDE.md workflow; the per-language gates in §4 |
| **Unit tests** — per pipeline stage | Each module (fusion, setpoint resolution, control loops, interlocks, constraints) is correct in isolation behind its interface | `P1-MAINT-1`; coverage `P1-TEST-1`; determinism `P1-TEST-2` |
| **Contract conformance** — schema + fixtures | Producer serializer **and** consumer parser both honor the shared wire format; positive fixtures validate, `*.bad-*` reject | §5; `contracts/` READMEs; the contract catalog ([`spec-contracts.md`](./spec-contracts.md)) |
| **Integration** — the up/down path | Stages compose end-to-end: controller HAL → pipeline → MQTT publish / latched REST write; platform MQTT ingest → store → resolve → controller REST | `P2-TEST-1` |
| **Scenario / simulation** | *Control behavior* is correct against a known trajectory: diurnal ramp, sensor dropout, actuator-stuck, interlock trips within latency | `P1-REL-1/3/4` asserted on the seeded HAL (`P1-TEST-2`); detailed in [`11-spec-controller-verification.md`](./controller/11-spec-controller-verification.md) and (optimizer side) [`07`](./optimizer/07-spec-optimizer-evaluation.md) |
| **Performance / load** | Targets hold under representative load — N-controller scaling, ingestion rate, fan-out lag | NFR [Performance Testing](../artifacts/non-functional-requirements.md); `P2-SCAL-1`, `P2-PERF-1…4` |
| **Frontend E2E** | Operator flows, live-update latency, initial-load + accessibility, against the production build | `P2-TEST-2` |

The enabling property for the middle rungs is **determinism**: the seeded HAL (`P1-TEST-2`) and the
deterministic digital twin make a control scenario a *reproducible assertion* rather than a flaky
observation. Where the LLM makes exact reproduction impossible, regression becomes **bounded
comparison** ([optimizer §07](./optimizer/07-spec-optimizer-evaluation.md)).

---

## 3. The feedback-loop ladder

The development loops, fastest → slowest. A change should fail at the earliest loop that can catch it.

1. **Inner loop** *(editor, seconds)* — `cargo check` / `clippy` / targeted `cargo test` on save; a
   seeded simulation makes any failing scenario reproducible on the spot.
2. **Pre-commit loop** *(local git hook —
   [`.githooks/pre-commit`](../../../.githooks/pre-commit))* — the **Rust gate** (`fmt --check`,
   `clippy -D warnings`, `check`, `test`, scoped to `climate-controller/`) and the **contracts gate**
   (§5), each fired only when staged files touch its surface. The Go and frontend gates run in the CI
   loop (loop 6) rather than this hook — it stays scoped to the fast, dependency-light Rust and
   contracts gates so an unrelated commit is never blocked on Docker/Node.
3. **Contract loop** *(cross-component)* — the schema + fixtures are the **shared oracle**: when a
   producer or consumer drifts, the contract harness catches it; a deliberate contract change is
   versioned and recorded in an ADR ([`contracts/README.md`](../../../contracts/README.md), RFC-007).
4. **Runtime-observability loop** *(the deployed system's feedback about itself)* — MQTT telemetry +
   REST `/health` (`P1-OBS-1/2`) for a headless controller; `/metrics` + Prometheus/Grafana +
   structured audit logs (`P2-OBS-1/2`) for the platform; `optimizer_run_id` traceability
   (`P3-OBS-1`) for plans. This is the "is it behaving in situ" loop.
5. **Regression-baseline loop** *(slowest)* — captured performance baselines (NFR Performance
   Testing) and per-backend optimizer plan-variance baselines ([§07](./optimizer/07-spec-optimizer-evaluation.md))
   become the regression reference, re-captured **deliberately** on a model/prompt/config change.
6. **CI loop** *(outer, clean environment)* — every gate above re-run on push/PR away from the
   developer's machine. **Built** ([`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml),
   GitHub Actions): the Rust gate, the contract harness, the Go gate (unit + testcontainers
   integration), and the frontend gate run today; Rust coverage and the Phase 3 Python gate (with
   the load suite) join as that work lands. Topology is §6 and
   [RFC-010](../../decisions/request-for-comments.md#rfc-010-verification--continuous-integration-strategy);
   remaining work is in [`docs/backlog.md`](../../backlog.md).

---

## 4. Tooling matrix

Per surface, what verifies it and whether it exists today. "Lands with its phase" tooling is named
here so the strategy is complete, but is wired when that phase is implemented — not before.

| Surface | Tooling | Status |
|---|---|---|
| **Rust controller** (P1) | `cargo fmt` · `cargo clippy --all-targets --all-features -D warnings` · `cargo check` · `cargo test` | **Present** — pre-commit Rust gate + CI |
| Rust coverage (`P1-TEST-1` ≥ 90%) | `cargo llvm-cov` | To wire |
| **Contracts** (all phases) | Ajv (Draft 2020-12) + `ajv-formats` for JSON Schema; `@redocly/cli` lint for OpenAPI; fixtures as pass/`*.bad-*`-fail cases — driven by [`scripts/validate-contracts.mjs`](../../../scripts/validate-contracts.mjs) (`npm run validate:contracts`) | **Present** — §5 |
| **Go platform** (P2) | `gofmt` · `go vet` · `golangci-lint` · `go test`; testcontainers for the TimescaleDB up/down path (`P2-TEST-1`) | **Present** — CI (`go test` unit gate + a separate testcontainers TimescaleDB integration job); CI-only, not in the pre-commit hook |
| **React frontend** (P2a) | component/unit (Vitest + Testing Library); **Playwright** (E2E + live-update latency); **Lighthouse CI** (initial-load + a11y) — both against the production build (`P2-TEST-2`) | **Partially wired** — ESLint · `tsc` · Vitest + blocking **Lighthouse CI** (static production build, `.lighthouserc.json`) run in CI; **Playwright** E2E stays local (needs the live deploy stack), not yet in CI |
| **Python optimizer** (P3) | `ruff` · `mypy` · `pytest`; the constraint-engine + golden-scenario suites of [§07](./optimizer/07-spec-optimizer-evaluation.md) (`P3-TEST-1`) | Lands with Phase 3 |
| **Load / scale** (P2) | `docker-compose.override.yml` generator (N controllers) + MQTT publisher load; observe ingestion, fan-out lag, DB write rate per NFR Performance Testing | Lands with Phase 2 |

No new **runtime** dependency is introduced for verification; the contract harness reuses `ajv`
(already a dependency) and adds `@redocly/cli` as a pinned **devDependency** — the linter the OpenAPI
contract READMEs already mandate.

---

## 5. The contract-validation harness

The cross-component oracle, now wired locally ([`scripts/validate-contracts.mjs`](../../../scripts/validate-contracts.mjs),
`npm run validate:contracts`). It automates the check each contract README specified and
[`docs/backlog.md`](../../backlog.md) previously tracked as "blocked on CI":

- **JSON-Schema contracts** ([`contracts/mqtt/`](../../../contracts/mqtt/),
  [`contracts/frontend-ws/`](../../../contracts/frontend-ws/)) — every `examples/<frame>.*.json`
  validates against `<frame>.schema.json`; every `*.bad-*.json` must **fail**.
- **OpenAPI contracts** ([`contracts/controller-rest/`](../../../contracts/controller-rest/),
  [`contracts/frontend-rest/`](../../../contracts/frontend-rest/)) — each example validates against
  its named component schema (mapped by the dir's `examples/cases.json`), and `openapi.json` is
  linted with Redocly using the contract's `redocly.yaml`.
- Cross-schema `$ref`s resolve **offline** — each schema is registered under an `$id` derived from
  its path (the `https://greenhouse.local/…` base the MQTT/WS schemas embed); nothing hits the
  network.

The harness runs in the **pre-commit contracts gate** and is the unit the **CI loop** (§6) re-runs in
a clean environment on push/PR. A contract change is still versioned and ADR-recorded
([`contracts/README.md`](../../../contracts/README.md)) — the harness proves *conformance*, not that
the change was *intended*.

---

## 6. CI topology

The CI platform is **GitHub Actions** ([`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml));
it closes the outer loop, re-running gates in a clean environment on push/PR. **Running today:** the
Rust gate (`fmt`/`clippy`/`check`/`test`, scoped to `climate-controller/`) and the contract harness —
the same gates the pre-commit hook fires locally, now also enforced away from the developer's machine
(the hook stays staged-path-scoped so it never blocks an unrelated commit). The **Go gate** —
`gofmt`/`go vet`/`golangci-lint`/`go build`/`go test`, plus a separate testcontainers TimescaleDB
integration job (`P2-TEST-1`) — and the **frontend gate** — ESLint, `tsc`, Vitest, and a blocking
**Lighthouse CI** run against the static production build — now run too; the frontend's **Playwright**
E2E stays local for now (it needs the live deploy stack). **Still to wire,** per the tooling matrix in
§4: Rust coverage against `P1-TEST-1` (`cargo llvm-cov`), the frontend E2E harness, the load suite, and
— with Phase 3 — the Python gate. The decision and its scope are
[RFC-010](../../decisions/request-for-comments.md#rfc-010-verification--continuous-integration-strategy);
the remaining work is the CI item in [`docs/backlog.md`](../../backlog.md).

---

## 7. Cross-spec map

| Concern | Owned by | Defers to |
|---|---|---|
| Verification & feedback-loop strategy, tooling matrix, CI topology, contract harness | this file | [NFR doc](../artifacts/non-functional-requirements.md), [`spec-contracts.md`](./spec-contracts.md) |
| Quality *targets* (coverage, latency, scale, reliability) | [NFR doc](../artifacts/non-functional-requirements.md) | — (single source) |
| Controller test pyramid + golden control/safety scenarios | [`11-spec-controller-verification.md`](./controller/11-spec-controller-verification.md) | this file, NFR doc |
| Optimizer evaluation & regression testing | [`07-spec-optimizer-evaluation.md`](./optimizer/07-spec-optimizer-evaluation.md) | this file, NFR doc |
| Wire-format contents the harness checks | [`contracts/`](../../../contracts/) | RFC-007 |

If a verification change can't be traced to this file, a per-component verification doc, or the NFR
targets they discharge, it doesn't belong in the strategy.
