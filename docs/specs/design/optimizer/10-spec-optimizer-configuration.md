# Optimizer — Configuration

> **Purpose:** Catalogue the optimizer's service configuration — data-store DSN, Phase
> 2 endpoint, LLM provider/sampling, objective weights, and the data-quality,
> twin-robustness, application-gate, and service thresholds — and how it is supplied
> via environment variables / the Compose file rather than a per-greenhouse TOML.

Part of the [optimizer set](./01-spec-optimizer-overview.md); the thresholds here are
referenced throughout the set (e.g.
[planning](./04-spec-optimizer-planning.md#1-llm-driven-planning),
[input gating](./06-spec-optimizer-input-gating.md),
[twin robustness](./03-spec-optimizer-digital-twin.md#2-robustness--fidelity),
[resilience](./08-spec-optimizer-resilience.md)).

---

The optimizer's service configuration — data-store DSN, Phase 2 API endpoint, LLM provider/endpoint,
sampling parameters, objective weights, the input data-quality thresholds, the twin-robustness and
service-resilience thresholds, and the application-gate thresholds — is supplied via **environment
variables / the Compose file**, mirroring the Phase 2
convention rather than a per-greenhouse TOML (contrast the controller's config). Per-greenhouse inputs
(which house to plan, its crop-safe bounds) are read from Phase 2 at cycle time, not configured here.

```toml
[data]
postgres_dsn = "postgresql://optimizer_ro:***@platform-db:5432/greenhouse"  # read-only role; SELECT on the RFC-008 view surface only
platform_api_url = "https://platform/api"

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
