---
id: ADR-0009
title: Custom openrig.memory.* telemetry schema for memory observation
status: accepted
date: 2026-10-19
tags: [memory, telemetry, observability]
supersedes: []
related: [ADR-0006]
---

# ADR-0009: Custom openrig.memory.* telemetry schema for memory observation

## Context

RIG-36 (memory observability) needs a telemetry schema for memory delivery events — tracking what memory was delivered, to which session, at what cost, and whether it was stale. The decision: adopt the emerging `gen_ai.memory.*` OpenTelemetry semantic convention, or define a custom `openrig.memory.*` schema.

OpenRig has 11 delivery surfaces (session prompt, restore preload, skill load, bundle hint, world profile, seat recap, mission spec, progress file, steering surface, notes, learned) and 7 authority tiers (operator, human, architect, orchestrator, advisor, implementer, reviewer). These are domain-specific concepts with no equivalent in the OTel `gen_ai.*` namespace.

## Decision

Use a custom `openrig.memory.*` namespace for memory telemetry.

### Namespace

`openrig.memory.*`

### Attributes

| Attribute | Type | Description |
|-----------|------|-------------|
| `openrig.memory.surface` | string | Delivery surface (e.g., `session_prompt`, `restore_preload`, `skill_load`) |
| `openrig.memory.authority_tier` | string | Authority tier of the memory source (e.g., `operator`, `orchestrator`) |
| `openrig.memory.delivery_phase` | string | When in the session lifecycle the memory was delivered (e.g., `startup`, `restore`, `on_demand`) |
| `openrig.memory.content_hash` | string | SHA-256 of the delivered content (for dedup and staleness detection) |
| `openrig.memory.token_cost` | int | Estimated token cost of the delivered memory |
| `openrig.memory.delivery_hint` | string | The resolved delivery hint (`send_text`, `guidance_merge`, `file_ref`) |

### Event names

| Event | Description |
|-------|-------------|
| `openrig.memory.delivered` | Memory content delivered to a session |
| `openrig.memory.read` | Memory content read by a session (from disk or cache) |
| `openrig.memory.written` | Memory content written (new or updated) |

### Migration trigger

Migrate to `gen_ai.memory.*` when BOTH conditions hold:
1. `gen_ai.memory.*` is ratified by the OTel Semantic Conventions SIG (not just proposed)
2. OpenRig adopts an OTel pipeline (collector, exporter, backend)

Until both conditions are met, the custom schema avoids coupling to an unstable convention and avoids introducing OTel infrastructure that OpenRig does not use.

## Rejected alternatives

### Option A: Adopt gen_ai.memory.* (emerging OTel convention)

Rejected because:
- `gen_ai.memory.*` is not a stable OTel convention — it is a proposal without SIG ratification
- No OTel infrastructure exists in OpenRig (no collector, no exporter, no backend)
- The 11 delivery surfaces and 7 authority tiers are domain-specific and have no mapping in the generic convention
- Adopting an unstable convention creates migration risk when the spec changes

## Rationale

The custom schema maps directly to OpenRig's domain model. Every attribute corresponds to a concept that already exists in the codebase (`deliveryHint`, `authority`, `surface`). The schema is self-contained — it does not require OTel libraries, collectors, or backends. The migration trigger is explicit and auditable.

## Consequences

- Memory observation events use `openrig.memory.*` attributes throughout the codebase
- No OTel dependency is introduced
- The schema is documented here and in the codebase (types.ts, startup-orchestrator.ts)
- When the migration trigger fires, a new ADR supersedes this one with the mapping

## Revisit triggers

- `gen_ai.memory.*` ratified by OTel Semantic Conventions SIG
- OpenRig adopts an OTel pipeline for any other telemetry
- A third-party tool requires OTel-compatible memory telemetry from OpenRig
