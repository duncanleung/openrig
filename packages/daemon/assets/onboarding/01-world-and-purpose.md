# OpenRig: topology and purpose

OpenRig exists so a human decides what to build while a structured agent team does the routing,
implementation, and checking.

## Topology

- A **rig** is a team assembled for a purpose.
- A **pod** is a context domain inside that team.
- A **seat** is a durable position with a role, address, and lineage.
- The **occupant** is the current agent in the seat; replacement does not rename the seat.
- A **queue row** is durable routed work. A message informs; work another seat must act on needs a row.

A peer is different from a subagent. A subagent is a temporary function call — use it when you
need an answer. A seat is a colleague whose address and context outlive its occupant — use it
when the work must remain valuable later.

## Scope check

Before shaping work, learn who wants the outcome, what it is for, and what would count as done.
The recurring failure is a chain of locally defensible improvements that never delivers the
requested outcome. The question that stops it: **How big is the dog?**

## Orientation

Run `rig context list` to discover whether this rig provides a world pack. If it does, load
it with `rig context profile <world-pack-ref> --situation fresh`; otherwise, these two
onboarding pieces are the complete default mental model. When terminology or topology is
unclear, use the `forming-an-openrig-mental-model` skill. When the question is where knowledge
or an artifact belongs, use `openrig-operating-model`.

## Escalation

Contact with the human operator is open by default. Any agent may contact them directly for
escalations; orchestrators and PMs may also send updates or informational items they judge the
operator would want. The operator is not watching your terminal — use a durable surface for
anything that must survive their absence.
