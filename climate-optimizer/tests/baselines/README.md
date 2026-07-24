# Plan-variance baselines (spec-08 §3)

Recorded planner outputs the regression suite compares re-runs against, as a **bounded** match rather
than exact — the LLM is stochastic even at temperature 0
([spec 08 §3](../../../docs/specs/design/optimizer/08-spec-optimizer-evaluation.md),
[planning determinism](../../../docs/specs/design/optimizer/04-spec-optimizer-planning.md)). The
comparison, keying, and tolerance bands live in [`../plan_variance.py`](../plan_variance.py).

## Layout

```
baselines/<backend-slug>/<scenario-id>.json
```

- `<backend-slug>` is `BackendKey.slug` — `provider__model__prompt_version__sampling`, e.g.
  `ollama__llama3.2__v1__t0-p1` (`:` and `/` in a model name become `-`). A baseline is **per backend**:
  every allowlisted local model, cloud model, and fallback keeps its own, because each produces its own
  plan distribution.
- `<scenario-id>.json` is one contract-valid `OptimizerPlan` (validated on load against
  `contracts/optimizer-internal-plan-schema/`).

## Capturing a baseline is an offline act

Capture is **deliberate and offline** — it runs a live backend, so it never happens in CI. Re-capture:

- on a **provider** or **`prompt_version`** change (a reviewed ADR event), or
- when **adding a model** to a provider's `available_models` allowlist — capture that model's baseline
  *before* it is offered for runtime selection.

An operator **switching `model` at runtime** among already-allowlisted models is **not** a capture
event: it selects the pre-captured baseline keyed by the now-active model. That is exactly why every
runtime-selectable model must be baseline-captured offline first.

Capture with `plan_variance.save_baseline(plan, key, scenario_id)` against a real planner run, review
the diff, and commit the JSON.
