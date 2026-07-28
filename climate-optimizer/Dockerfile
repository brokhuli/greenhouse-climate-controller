# syntax=docker/dockerfile:1
# Phase 3 optimizer (Python 3.12, uv-managed). Two stages: resolve the locked dependency set into a
# venv with uv, then run it on the same slim Python base. The astral uv image is `python:3.12-slim-
# bookworm` + the uv binary, so the interpreter path is identical across stages and the copied `.venv`
# stays valid. Mirrors the pinned-toolchain, multi-stage Dockerfiles for climate-platform/-frontend.
#
# The shared `contracts/` are NOT in this build context (they live at the repo root); they are bind-
# mounted read-only at runtime and located via CLIMATE_OPTIMIZER_CONTRACTS_DIR (see docker-compose.yml
# and schema_validation.py). The versioned planner prompts ARE in-context and ship in the image.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS build
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=0
# Dependencies first (cached across source-only changes), then the project itself.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-install-project --no-dev
COPY . .
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

FROM python:3.12-slim-bookworm
WORKDIR /app
RUN useradd --create-home --uid 10001 app
COPY --from=build --chown=app:app /app /app
# The venv is the interpreter; the prompt/contract dirs are pinned explicitly so resolution does not
# depend on the install being editable. Contracts are mounted at /contracts by Compose.
ENV PATH="/app/.venv/bin:$PATH" \
    CLIMATE_OPTIMIZER_PROMPTS_DIR=/app/prompts \
    CLIMATE_OPTIMIZER_CONTRACTS_DIR=/contracts
USER app
EXPOSE 8000
ENTRYPOINT ["python", "-m", "climate_optimizer"]
