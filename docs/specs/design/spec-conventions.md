# Spec Conventions

Conventions shared by every design spec set (controller, platform, frontend,
optimizer). Each set's overview links here rather than restating these rules, and
adds only the bullets specific to it (its NFR-ID vocabulary, its relative-link bases,
and 2a/2b slice tags where they apply).

## Reference, don't redefine

A fact owned by a single source of truth is **linked, never restated**. Each spec
applies a principle from its own angle and points to the canonical home for the
definition:

| Owned by | Source of truth |
|---|---|
| Cross-component wire formats (MQTT topics, payload schemas, REST shapes) | [`contracts/`](../../../contracts/), catalogued in [`spec-contracts.md`](./spec-contracts.md) |
| The physical system being controlled/managed | [`physical-system-single.md`](./physical-system-single.md), [`physical-system-multi.md`](./physical-system-multi.md) |
| Quality targets (performance, reliability, scale, test) | [NFR doc](../artifacts/non-functional-requirements.md) |
| Cross-cutting decisions and their rationale | [RFCs](../../decisions/request-for-comments.md), [ADRs](../../decisions/architecture-design-record.md) |
| System-wide constraint inventory | [constraints artifact](../artifacts/constraints.md) |

If a change can't be traced to one of these — or to a spec that defers to them — it
doesn't belong in the spec set.
