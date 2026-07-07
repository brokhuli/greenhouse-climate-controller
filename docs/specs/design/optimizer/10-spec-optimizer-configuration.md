# Optimizer — Configuration

> **Purpose:** Catalogue the optimizer's service configuration — Phase
> 2 endpoint and its service-auth mode ([RFC-011](../../../decisions/request-for-comments.md#rfc-011-service-to-service-auth-as-a-config-gated-hardening-mode-supersedes-rfc-009)), LLM provider/sampling, objective weights, local
> cost schedule, and the data-quality, twin-robustness, application-gate, and service thresholds — and
> how it is supplied via environment variables / the Compose file rather than a per-greenhouse TOML.

Part of the [optimizer set](./01-spec-optimizer-overview.md); the thresholds here are
referenced throughout the set (e.g.
[planning](./04-spec-optimizer-planning.md#1-llm-driven-planning),
[input gating](./06-spec-optimizer-input-gating.md),
[twin robustness](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity),
[resilience](./08-spec-optimizer-resilience.md)).

---

The optimizer's service configuration — Phase 2 API endpoint, LLM provider/endpoint,
sampling parameters, objective weights, the local time-of-use cost schedule, the input data-quality thresholds, the twin-robustness and
service-resilience thresholds, and the application-gate thresholds — is supplied via **environment
variables / the Compose file**, mirroring the Phase 2
convention rather than a per-greenhouse TOML (contrast the controller's config). Per-greenhouse inputs
(which house to plan, its crop-safe bounds) are read from Phase 2 at cycle time, not configured here.

```toml
[data]
platform_api_url = "https://platform/api"

[platform_auth]
# Service-to-service auth for the Phase 2 setpoint write path (RFC-011).
# "trusted_network" (default): call POST /setpoints untokened — single-host local posture.
# "oidc": obtain a Keycloak client-credentials token and present it as Bearer — cloud / multi-host.
mode = "trusted_network"              # must match the platform's SERVICE_AUTH_MODE
oidc_token_url = ""                   # Keycloak token endpoint; required only when mode = "oidc"
oidc_client_id = "optimizer"          # confidential client; narrow setpoints:write service role
oidc_client_secret = ""               # set via PLANNER_OIDC_CLIENT_SECRET env var; never in file

[llm]
# Primary backend: "anthropic" | "openai"
# Falls back to "ollama" automatically if the primary is unreachable.
provider = "anthropic"
model = "claude-sonnet-4-6"
api_key = ""                          # set via PLANNER_API_KEY env var; never in file
fallback_provider = "ollama"
fallback_model = "llama3"
fallback_endpoint = "http://ollama:11434"
temperature = 0                       # greedy decoding for reproducible plans; see planner determinism
top_p = 1.0
max_tokens = 1024                     # response budget; distinct from the 4000-token context budget

[planning]
cycle_interval_minutes = 30
horizon_hours = 12                    # extended to 24 only near day boundaries
context_token_budget = 4000           # serializer raises if exceeded; no silent truncation
state_change_threshold = 0.05         # fraction deviation to suppress a cycle's LLM call
objective_weights = { anticipation = 1.0, coupling = 1.0, efficiency = 0.5 }

[cost]
# Local static time-of-use schedule for the Phase 3 efficiency objective.
# Live tariffs / external price feeds are out of scope until a later phase.
time_of_use = [
  { start = "00:00", end = "06:00", relative_cost = 0.7 },
  { start = "06:00", end = "16:00", relative_cost = 1.0 },
  { start = "16:00", end = "21:00", relative_cost = 1.4 },
  { start = "21:00", end = "24:00", relative_cost = 0.8 },
]

[application]
confidence_threshold = 0.8            # below → escalate to operator
# crop-safe bounds come from the Phase 2 crop profile, not from here

[data_quality]
max_telemetry_age_minutes = 35        # latest reading per required metric must be newer; else gate fails → input gating
required_metrics = ["temperature", "humidity", "co2", "par"]   # VPD / DLI are derived from these
min_history_coverage = 0.8            # fraction of expected samples in the window; large gaps fail the gate

[twin]
solver_max_step_minutes = 5           # integrator step ceiling; non-finite / non-converging step = sim divergence → twin robustness
divergence_threshold = 0.15           # one-step predicted-vs-observed residual fraction; sustained breach = fidelity fault → twin robustness

[service]
cycle_timeout_seconds = 60            # a cycle exceeding this is abandoned and the last plan extended; aligns with P3-PERF-2
escalation_dedup_window_minutes = 60  # recurring escalations for one greenhouse collapse into one standing entry → resilience
```
