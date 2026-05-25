# Local Environment Decisions

A running log of decisions about the local development environment, tooling, and configuration
— distinct from architecture decisions (`architecture-design-record.md`) and open proposals
(`request-for-comments.md`). Newest entries at the top.

---

## 2026-05-25 — Repository layout: single monorepo for all three phases (for now)

**Decision:** Keep `controller` (Phase 1, Rust), `platform` (Phase 2, Go), and `optimizer`
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
