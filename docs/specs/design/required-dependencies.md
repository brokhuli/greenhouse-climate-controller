# Required Dependencies

What you need to install on the development machine to build, run, and verify each phase. This is
an **environment** checklist (host tooling), not a list of code-level libraries — per-project
libraries (Cargo crates, npm packages, Python packages) are pulled by each phase's package manager
from its manifest and are **not** listed here.

> **Target environment:** Windows 11, VS Code, codebase on the Windows filesystem under `C:\code\`,
> containers via Docker Desktop (WSL 2 backend). See
> [`local-environment-record.md`](../../decisions/local-environment-record.md) for why.

## Conventions

- **Install command:** `winget` examples are given where a reliable package ID exists; otherwise an
  official download link. VS Code extensions use `code --install-extension <id>`.
- **Runs in Docker, not on the host:** infrastructure (MQTT broker, databases) runs as containers,
  so it is *not* a host install. It is listed under each phase only as a reminder of what the stack
  needs at runtime.
- **LSP / editor tooling is included.** Each phase lists the language server(s) and VS Code
  extensions that give in-editor diagnostics, formatting, and go-to-definition — these are
  development dependencies even though they don't ship in the build.
- **Per-project tooling is not a host install.** Formatters, linters, and test runners that come
  from a project manifest (e.g. `eslint`, `vitest` via `package.json`) install with that project's
  dependencies and are noted, not listed as separate installs.

---

## Shared baseline (all phases)

These span every phase; install once.

| Tool | Purpose | Install (Windows) |
|---|---|---|
| **Git** | Version control; `core.hooksPath` points at `.githooks/` | `winget install Git.Git` |
| **VS Code** | Editor / IDE host for all phases | `winget install Microsoft.VisualStudioCode` |
| **Docker Desktop** | Container runtime (WSL 2 backend); runs the MQTT broker, databases, and the eventual full stack | `winget install Docker.DockerDesktop` |

**Baseline VS Code extensions** (already recommended in [`.vscode/extensions.json`](../../../.vscode/extensions.json)):

```
code --install-extension editorconfig.editorconfig
code --install-extension esbenp.prettier-vscode
code --install-extension streetsidesoftware.code-spell-checker
code --install-extension yzhang.markdown-all-in-one
```

After cloning, point Git at the repo's hooks once: `git config core.hooksPath .githooks`
(local Git config is not committed and does not travel with a clone).

---

## Phase 1 — Greenhouse Climate Controller

Stack: **Rust (Tokio)** controller + **SvelteKit** dashboard, talking over **MQTT** / REST /
WebSockets, with optional **SQLite** persistence. See
[`spec-climate-controller.md`](./spec-climate-controller.md) and
[`tech-stack-decisions.md`](./tech-stack-decisions.md).

### 1. Rust toolchain (the controller)

| Tool | Purpose | Install (Windows) |
|---|---|---|
| **rustup** | Toolchain manager; installs and pins `rustc` + `cargo` | `winget install Rustlang.Rustup` |
| **MSVC C++ Build Tools + Windows SDK** | Required linker (`link.exe`) for the default `x86_64-pc-windows-msvc` target — Rust will not link without it | `winget install Microsoft.VisualStudio.2022.BuildTools`, then add the **“Desktop development with C++”** workload |

`rustup` then provides the rest of the workflow toolchain as components (no separate install):

| Component | Maps to workflow step | Command |
|---|---|---|
| `cargo` | build / run | `cargo build`, `cargo run` |
| `cargo check` | typecheck | `cargo check` |
| `rustfmt` | format | `cargo fmt` (`rustup component add rustfmt`) |
| `clippy` | lint | `cargo clippy` (`rustup component add clippy`) |
| built-in test harness | tests | `cargo test` |

> **Pin the toolchain** with a `rust-toolchain.toml` in `climate-controller/` so the version is reproducible
> across machines and CI. (Added with the Cargo project per
> [`climate-controller/README.md`](../../../climate-controller/README.md).)

### 2. Frontend toolchain (the SvelteKit dashboard)

| Tool | Purpose | Install (Windows) |
|---|---|---|
| **Node.js LTS** | Runs SvelteKit dev server / build; bundles `npm` | `winget install OpenJS.NodeJS.LTS` |
| **(optional) pnpm via Corepack** | Faster, disk-efficient package manager | `corepack enable` (ships with Node) |

Project-level tooling — **Prettier**, **ESLint**, **`svelte-check`** (TypeScript/Svelte typecheck),
and the test runner (**Vitest** / **Playwright**) — comes from the frontend's `package.json` via
`npm install`; it is **not** a host install. Pin the Node version with an `.nvmrc` or the
`engines` field once the frontend project is scaffolded.

### 3. Language servers & editor extensions (LSP)

| Extension | Provides | Install |
|---|---|---|
| **rust-analyzer** | Rust LSP — diagnostics, completion, inline types, go-to-def | `code --install-extension rust-lang.rust-analyzer` |
| **Svelte for VS Code** | Svelte/SvelteKit LSP (`svelte-language-server`) + syntax | `code --install-extension svelte.svelte-vscode` |
| **Even Better TOML** | LSP for the TOML config files (setpoints, zones, τ/coupling params) | `code --install-extension tamasfe.even-better-toml` |

### 4. MQTT broker + client tooling

- **Broker (runtime, Docker — not a host install):** Mosquitto or EMQX runs as a container from the
  Phase 1 / deploy compose stack. Nothing to install on the host.
- **MQTT client (dev/debug, optional but recommended):** a client to watch topics and hand-publish
  actuator commands while developing:
  - **MQTT Explorer** (GUI) — visual topic tree, retained-message inspection. [Download](https://mqtt-explorer.com/).
  - or **mosquitto clients** (`mosquitto_pub` / `mosquitto_sub`) — already available inside the
    broker container via `docker exec`, so a separate install is optional.

### 5. SQLite (optional persistence)

- The controller links SQLite **into the binary** via the Rust `rusqlite` crate's `bundled` feature,
  so **no host install is needed** for the app to run.
- **Optional for inspection during development:** the `sqlite3` CLI
  (`winget install SQLite.SQLite`) or a VS Code SQLite viewer extension to open the local `.db` file.

### Phase 1 verification checklist

After installing, confirm the workflow toolchain resolves (matches the
[`CLAUDE.md`](../../../CLAUDE.md) "format, lint, typecheck, test" gate):

```powershell
rustc --version; cargo --version          # Rust toolchain
cargo fmt --version; cargo clippy --version   # format + lint
node --version; npm --version             # frontend toolchain
docker --version; docker compose version  # container runtime (MQTT broker)
```

---

## Phase 2 — Local PaaS Platform

> _Stub — to be filled out when Phase 2 begins._
>
> Anticipated host tooling: **Go** toolchain (+ `gopls` LSP), **Node.js** (React dashboard), Docker
> Compose stack (Postgres/TimescaleDB, MQTT broker, Keycloak, reverse proxy), and a Postgres client.
> See [`tech-stack-decisions.md`](./tech-stack-decisions.md#phase-2--local-paas-platform-docker-only).

---

## Phase 3 — Local LLM Climate Optimizer

> _Stub — to be filled out when Phase 3 begins._
>
> Anticipated host tooling: **Python** (+ a virtual-environment / dependency manager and the
> Pylance/Ruff LSP tooling), a **local LLM runtime** (e.g. Ollama) or an API key for a hosted LLM,
> and access to the Phase 2 Postgres/TimescaleDB.
> See [`tech-stack-decisions.md`](./tech-stack-decisions.md#phase-3--local-llm-climate-optimizer-python-only).
