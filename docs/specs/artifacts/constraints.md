# Constraints

The fixed boundaries the system is built within — environment, deployment, structure, and
architecture. These are **already-decided** constraints, recorded authoritatively in the ADR, the
RFCs, and the local-environment record; this page is the **consolidated index** so they can be seen
at a glance and are not silently violated mid-implementation. Each entry links to its governing
decision, which remains the source of truth.

---

## Platform & environment

| Constraint | Source |
|---|---|
| Development is on **Windows 11**, with VS Code as the IDE host. | [local-environment-record.md](../../decisions/local-environment-record.md), [required-dependencies.md](../design/required-dependencies.md) |
| Codebase lives on the **Windows filesystem under `C:\code\`** — outside OneDrive-synced folders (avoids build/git corruption) and short enough to preserve headroom against the 260-char `MAX_PATH` limit. | [local-environment-record.md](../../decisions/local-environment-record.md) |
| Container runtime is **Docker Desktop (WSL 2 backend)**; `docker` / `docker compose` on the Windows PATH. The project stays runtime-agnostic — only Dockerfiles and Compose files define the stack. | [local-environment-record.md](../../decisions/local-environment-record.md) |
| Toolchains are **pinned for reproducibility** (e.g. `rust-toolchain.toml` for Phase 1). | [required-dependencies.md](../design/required-dependencies.md) |

## Deployment & scale

| Constraint | Source |
|---|---|
| **Fully local, zero cloud.** The entire stack runs under Docker Compose on one machine; no cloud account or external managed service is required. | [high-level-idea.md](../design/high-level-idea.md), [spec-climate-platform.md §12](../design/spec-climate-platform.md#12-deployment) |
| One developer machine must host the **whole stack plus 20–50 simulated controllers** concurrently. This is the resource envelope all performance targets assume. | [Non-Functional Requirements](./non-functional-requirements.md) |
| **No real hardware.** The HAL is pure simulation; the controller never runs on a physical device, so there is no embedded/real-time-OS target. | [spec-climate-controller.md §13](../design/spec-climate-controller.md#13-deployment) |

## Structure & project

| Constraint | Source |
|---|---|
| **Single monorepo for now** — Phase 1 (Rust), Phase 2 (Go), Phase 3 (Python) and `contracts/` together. Splitting into per-phase repos is deferred until after implementation. | [local-environment-record.md](../../decisions/local-environment-record.md) |
| Each phase stays **self-contained under its own folder with its own toolchain**, so the eventual repo split is a clean extraction. | [local-environment-record.md](../../decisions/local-environment-record.md) |
| **Solo project.** The usual reasons to split repos or add access control (separate teams, independent release cadences) do not apply yet. | [local-environment-record.md](../../decisions/local-environment-record.md) |

## Technical & architectural

| Constraint | Source |
|---|---|
| **Fixed language per phase:** Rust (Phase 1), Go (Phase 2), Python (Phase 3). | [tech-stack-decisions.md](../design/tech-stack-decisions.md) |
| **`contracts/` is the single source of truth** for every cross-component wire format; all phases conform to it rather than redefining schemas. | [spec-contracts.md](../design/spec-contracts.md), RFC-007 |
| **Phase 2 is the sole setpoint authority**, and a controller's **REST API is its sole inbound write path** — MQTT is telemetry-only; the controller subscribes to no command topics. | [RFC-005](../../decisions/request-for-comments.md#rfc-005-setpoint-authority-and-delivery-chain) |
| **Sequential phasing:** Phase 1 → 2 → 3. Phase 4 is a stretch goal taken on only after the core product, and the core carries **no Phase 4 accommodation** except the HAL actuator-as-a-set-of-effects seam. | [RFC-006](../../decisions/request-for-comments.md#rfc-006-phase-4-seam-strategy), [spec-climate-controller.md §3](../design/spec-climate-controller.md#3-hal--simulation-model) |
| **Structural config requires a restart**; only setpoints/thresholds/overrides change at runtime (over REST). Adding/removing zones and changing HAL τ/coupling parameters are config-file + restart. | [spec-climate-controller.md §4](../design/spec-climate-controller.md#4-configuration--setpoints) |
