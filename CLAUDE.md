# Project Instructions

## Development Workflow
- Run format, lint, typecheck, and tests before completion
- Do not introduce dependencies without justification

## Local Stack
- To start/restart the stack at a given simulated time, use `SIM_START_TS=<time> bash deploy/scripts/fresh-run.sh [N]` (e.g. `SIM_START_TS=2pm`; also accepts `14:00`/`now`/RFC 3339) — its guarded reset prevents the detail-chart live-freeze; not a manual `down`/`gen-controllers`/`up`
- Use a plain `docker compose ... up -d` only to continue the current run

## Architecture
- Keep modules cohesive
- Prefer explicit interfaces
- Separate domain logic from infrastructure
- Favor readability over cleverness

## Testing
- Add tests for all new behavior
- Avoid untested logic

## Git
- Don't commit unless directed to do so
- Use conventional commits
- Keep commits focused
- Update documentation when behavior changes
