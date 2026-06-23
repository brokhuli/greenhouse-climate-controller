# syntax=docker/dockerfile:1
# Phase 1 controller (Rust), containerized for the Phase 2 local stack (operations §2).
# The HAL is pure simulation, so there is no hardware dependency — each container is a
# lightweight process that connects to the broker and serves its REST control surface.
# The config file path is the binary's first argument; Compose mounts a per-greenhouse
# TOML and passes its path as the command.
FROM rust:1.96-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked --bin climate-controller

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/climate-controller /usr/local/bin/climate-controller
# REST control surface (the platform relays setpoint edits here over the Docker network).
EXPOSE 8080
ENTRYPOINT ["climate-controller"]
