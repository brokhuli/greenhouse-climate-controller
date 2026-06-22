# Local Environment Decisions

A running log of decisions about the local development environment, tooling, and configuration
— distinct from architecture decisions (`architecture-design-record.md`) and open proposals
(`request-for-comments.md`). Newest entries at the top.

---

## 2026-06-22 — CI platform: GitHub Actions (clean-environment gate)

**Decision:** Adopt **GitHub Actions** as the CI platform and wire a minimal v1 workflow
([`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)) that re-runs, on push to `main` and on
every PR, the two gates already defined locally: the **Rust gate** (`cargo fmt --check` / `clippy -D
warnings` / `check` / `test`, in `climate-controller/`) and the **contract harness** (`npm ci && npm
run validate:contracts`). Two parallel jobs on `ubuntu-latest`. This closes the deferred outer loop in
[RFC-010](./request-for-comments.md#rfc-010-verification--continuous-integration-strategy) and the
CI half of the original backlog item.

**Why:**
- The gates ran only locally via [`.githooks/pre-commit`](../../.githooks/pre-commit), which is opt-in
  (`git config core.hooksPath .githooks` does not travel with a clone), `--no-verify`-bypassable, and
  staged-path-scoped — so nothing guaranteed they ran on a clean checkout. CI makes that enforcement
  real.
- Phase 1 is complete and green (a clean baseline to lock in) and Phase 2 (Go) is next — the point at
  which a clean-environment runner for the cross-component contract harness starts to matter.
- GitHub Actions needs no infrastructure to stand up and is free at this scale; choosing it is what
  satisfied RFC-010's "until a CI platform is adopted" condition.

**Consequences / notes:**
- **First-party actions only** (`actions/checkout`, `actions/setup-node`, `actions/cache`) — no
  third-party action is introduced, honoring CLAUDE.md's dependency caution. Cargo build artifacts are
  cached via `actions/cache` keyed on `Cargo.lock`; cold Rust builds are otherwise slow.
- No rust-setup action: `ubuntu-latest` ships rustup, which honors
  [`climate-controller/rust-toolchain.toml`](../../climate-controller/rust-toolchain.toml) (pins
  `1.96.0` + `rustfmt`/`clippy`) and installs the toolchain automatically.
- Both jobs are hermetic — no service containers. The Node 24 / Windows Redocly teardown quirk noted
  in the 2026-06-18 entry does not apply on Linux CI.
- **Deferred (by design):** CD/deployment (no remote target — the stack is local-only via
  `deploy/docker-compose.yml`); Rust coverage enforcement (`cargo llvm-cov` vs `P1-TEST-1`); and the
  Go/Python/frontend/load gates, each landing with its phase. Tracked in
  [`docs/backlog.md`](../backlog.md); the full strategy is
  [`spec-verification.md`](../specs/design/spec-verification.md).

---

## 2026-06-18 — Contract-validation harness: Ajv + pinned Redocly, run via npm + pre-commit

**Decision:** Wire the long-specified `contracts/` validation as a committed Node harness —
[`scripts/validate-contracts.mjs`](../../scripts/validate-contracts.mjs), invoked by
`npm run validate:contracts` and by a new contracts gate in
[`.githooks/pre-commit`](../../.githooks/pre-commit). It validates every contract's JSON Schema /
OpenAPI fixtures with **Ajv** (Draft 2020-12, already a repo dependency) and lints the two
`openapi.json` documents with **`@redocly/cli`**, added as a **pinned devDependency**. This implements
[RFC-010](./request-for-comments.md#rfc-010-verification--continuous-integration-strategy) and resolves
the harness half of the backlog item; the **CI** half stays open.

**Why:**
- The check was already specified in every contract README but ran only by hand, so a schema
  regression or drifted fixture went uncaught. A committed harness makes it a real gate.
- It needs no CI to be useful — it runs locally and in the pre-commit hook today, gated by staged
  paths so docs-only commits are not blocked on Node (mirroring the crate-scoped Rust gate).
- `ajv`/`ajv-formats` were already present; `@redocly/cli` is the exact OpenAPI linter the
  `controller-rest` / `frontend-rest` READMEs already mandate (and ship a `redocly.yaml` for), so
  pinning it adds no new *conceptual* dependency — only determinism over ad-hoc `npx`. No runtime
  dependency is added.

**Consequences / notes:**
- Requires `npm install` before the gate works; the hook skips with a clear message if `node_modules`
  is absent.
- On Node 24 / Windows the Redocly CLI can hit a libuv teardown assertion *after* a clean lint; the
  harness forgives a nonzero exit only when the success marker is present, so a real lint failure is
  still caught.
- The full strategy this serves is [`spec-verification.md`](../specs/design/spec-verification.md); the
  remaining clean-environment **CI** pipeline is tracked in [`docs/backlog.md`](../backlog.md).

---

## 2026-05-25 — Repository layout: single monorepo for all three phases (for now)

**Decision:** Keep `climate-controller` (Phase 1, Rust), `climate-platform` (Phase 2, Go), and `climate-optimizer`
(Phase 3, Python) together in this one repository for now. Plan to split them into separate
repositories later, after implementation.

**Why:**
- The three phases share a contract (the MQTT message schemas in `contracts/`). A monorepo keeps
  that contract a single source of truth and lets the contract plus all of its consumers change
  in one atomic commit.
- The whole system deploys together as one local stack via a single `deploy/docker-compose.yml`
  — same deploy lifecycle, so same repo.
- Frictionless cross-referencing during development: all phases and the contract are in one
  working directory (grep/search across everything, no context switching).
- Solo project — the usual reasons to split (separate teams, independent release cadences,
  access control) don't apply yet.

**Consequences / notes:**
- Split is deferred until after implementation and is low lock-in — `git filter-repo` can extract
  each phase into its own repo while preserving history.
- When splitting, the shared `contracts/` folder must become a versioned, published artifact that
  each repo depends on, instead of an in-repo directory.
- Until then, keep each phase self-contained under its own folder with its own toolchain so the
  eventual extraction is clean.

---

## 2026-05-25 — Container runtime: Docker Desktop (WSL 2 backend)

**Decision:** Use Docker Desktop for Windows as the container runtime for local development.

**Why:**
- Claude Code and VS Code run on the Windows side, so Docker Desktop puts `docker` and
  `docker compose` directly on the Windows PATH — usable with no friction from PowerShell or
  Git Bash (no `wsl` prefixing, no cross-boundary path translation).
- Simplest setup; daemon lifecycle, localhost port forwarding, and bundled Compose/BuildKit
  are handled automatically.
- Free for this use case (solo / personal / open-source — well under Docker's paid-subscription
  threshold of >250 employees or >$10M revenue).

**Consequences / notes:**
- Requires Docker Desktop to be running; it uses a lightweight WSL 2 VM under the hood.
- The project stays runtime-agnostic — only Dockerfiles and `docker-compose.yml` define the
  stack, with no Docker Desktop-specific configuration.

---

## 2026-05-25 — Code location: Windows filesystem at `C:\code\`

**Decision:** Keep the codebase on the Windows filesystem under `C:\code\` and work with
Windows-native tooling.

**Why:**
- With Windows-side tools this is the fast native path — the slow Windows↔WSL filesystem
  boundary only matters for Linux/WSL workflows, which we are not using.
- `C:\code` sits outside OneDrive-synced folders (Documents/Desktop), avoiding sync issues that
  corrupt build artifacts and git state.
- A short root path preserves headroom against Windows' historic 260-char `MAX_PATH` limit.

**Convention:**
- Windows-native projects live under `C:\code\...`.
- If a project ever goes Linux-native, it lives under `~/code/...` inside the WSL distro
  instead (not under `C:\`).

---

## Reversibility — switching to native Docker Engine in WSL later

Recorded for future reference. Switching the above runtime decision to native Docker Engine
inside WSL 2 Ubuntu is low-cost (~1 hour) and requires **no code changes**, because Dockerfiles
and `docker-compose.yml` are runtime-agnostic.

Steps if switching:
1. Install Docker Engine inside Ubuntu; enable `systemd=true` in `/etc/wsl.conf` so the daemon
   autostarts.
2. Connect VS Code to WSL (Microsoft "WSL" extension) so the editor backend, terminal, and the
   Claude extension run inside Ubuntu.
3. `git clone` the repo into the WSL filesystem (`~/code/...`) for native I/O performance.
4. Re-run `git config core.hooksPath .githooks` — local git config is not committed and does not
   travel with a clone (the hooks' executable bit does, as mode `100755`).

Note: local images and named volumes built under Docker Desktop do not migrate to the native
engine — recreate them with `docker compose up` and re-seed Postgres from migrations.
