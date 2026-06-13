# Deploy

Root orchestration for the local stack — **Docker Compose**.

Brings up the MQTT broker, Phase 2 platform (API + database), and supporting services so the
whole greenhouse system runs with a single command. Also hosts the cross-phase end-to-end
harness (e.g. MQTT broker + device simulator + platform) used for integration testing.

The `docker-compose.yml` is scaffolded alongside the spec before implementation begins, so the MQTT broker is available from the first day of development.
