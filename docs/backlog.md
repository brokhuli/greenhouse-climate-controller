# Backlog

The central list of deferred and cross-cutting work for the project. Per-artifact follow-ups
still live where they belong — an RFC's **Open Questions**, a spec's **Deferred / Out of
Scope** section — but anything that spans multiple artifacts, or is blocked on infrastructure
the repo does not have yet (e.g. CI), is tracked here so it is not lost in a single document.

Newest entries at the top. When an item is picked up, remove it here and record the outcome in
the relevant ADR / RFC.

| Item | Why | Blocked on / When | Reference |
|---|---|---|---|
| Add a checked-in JSON Schema validation harness for `contracts/` | The MQTT schemas and their `examples/` fixtures are validated only by a one-off Ajv (Draft 2020-12, strict) run; nothing re-runs it, so a schema regression or a drifted example would go unnoticed. | When CI is available — there is no build system or CI in the repo yet. | [`contracts/mqtt/README.md`](../contracts/mqtt/README.md); ADR [2026-06-09](./decisions/architecture-design-record.md) |

### Notes

**Validation harness shape.** Run every `contracts/mqtt/*.schema.json` against
`contracts/mqtt/examples/**` — positive fixtures must validate, the `*.bad-*.json`
counter-examples must fail. Two viable forms when CI lands: a pinned Ajv dev-dependency script
(matches the manual check already used), or [`check-jsonschema`](https://github.com/python-jsonschema/check-jsonschema)
invoked in CI. Cross-schema `$ref`s resolve by `$id`, so each schema must be registered with
the validator (see the consuming-the-schemas note in the contracts README).
