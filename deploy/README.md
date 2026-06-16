# Deploy

Root orchestration for the local stack — **Docker Compose**.

The eventual stack is the full Phase 2 platform (API, database, reverse proxy, frontend, auth,
observability) plus the MQTT broker, running with a single command — and the cross-phase
end-to-end harness used for integration testing.

**Today (Phase 1) the only live service is the Mosquitto MQTT broker.** The Phase 1 controller
runs as a native Windows binary (controller spec §13), not a container, and connects to the
broker at `localhost:1883`. The Phase 2 platform services are present in
[`docker-compose.yml`](./docker-compose.yml) as commented-out placeholders (full topology in
[spec-platform-operations.md](../docs/specs/design/platform/spec-platform-operations.md#2-deployment)) and
are activated when Phase 2 begins.

Run the broker:

```
docker compose -f deploy/docker-compose.yml up -d
```

Broker config is [`mosquitto/config/mosquitto.conf`](./mosquitto/config/mosquitto.conf)
(anonymous auth + persistence per RFC-001); retained and in-flight QoS state persist in named
volumes across restarts.
