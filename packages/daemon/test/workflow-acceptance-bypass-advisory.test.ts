// RIG-92 — acceptance_bypass_possible is a static, non-fatal advisory.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseWorkflowSpec } from "../src/domain/workflow-spec-cache.js";
import { WorkflowValidator } from "../src/domain/workflow-validator.js";

const DIR = resolve(import.meta.dirname, "../src/builtins/workflow-specs");
const load = (name: string) => {
  const p = join(DIR, name);
  return parseWorkflowSpec(readFileSync(p, "utf-8"), p);
};
const bypass = (spec: ReturnType<typeof load>) =>
  new WorkflowValidator().validate(spec).issues.filter((i) => i.code === "acceptance_bypass_possible");

describe("acceptance_bypass_possible advisory (RIG-92)", () => {
  it("fires on exactly the three ticket-factory remediation edges, with the exact message", () => {
    const issues = bypass(load("ticket-factory.yaml"));
    expect(issues.map((i) => i.message).sort()).toEqual([
      "step 'validate' has acceptance gate, but remediation edge 'merge_disposition -> implement' bypasses it",
      "step 'validate' has acceptance gate, but remediation edge 'qa_check -> implement' bypasses it",
      "step 'validate' has acceptance gate, but remediation edge 'review -> implement' bypasses it",
    ]);
    expect(issues.every((i) => i.severity === "warning")).toBe(true);
  });

  it("is non-fatal: the spec still validates ok", () => {
    expect(new WorkflowValidator().validate(load("ticket-factory.yaml")).ok).toBe(true);
  });

  it("does not fire when no step declares acceptance", () => {
    const spec = load("ticket-factory.yaml");
    for (const s of spec.steps) delete s.acceptance;
    expect(bypass(spec)).toEqual([]);
  });

  it("does not fire for edges that do not bypass the gate (loop passes through the gated step)", () => {
    const spec = load("ticket-factory.yaml");
    // Remediation now returns to validate itself, so every loop re-passes the gate.
    for (const id of ["qa_check", "review", "merge_disposition"]) {
      spec.steps.find((s) => s.id === id)!.next_hop!.on!.failed = "validate";
    }
    expect(bypass(spec)).toEqual([]);
  });

  it("does not fire for the gated step's own exits (validate -> plan)", () => {
    const spec = load("ticket-factory.yaml");
    const fields = bypass(spec).map((i) => i.field);
    expect(fields.every((f) => !f?.includes("validate"))).toBe(true);
  });

  it("does not fire for a loop wholly upstream of the gate", () => {
    const spec = parseWorkflowSpec(
      `workflow:
  id: upstream-loop
  version: 1
  roles: { r: { preferred_targets: [a@rig] } }
  steps:
    - { id: a, actor_role: r, allowed_exits: [handoff, failed] }
    - { id: b, actor_role: r, allowed_exits: [handoff, failed], next_hop: { on: { failed: a } } }
    - { id: x, actor_role: r, allowed_exits: [handoff, failed], acceptance: { candidate: c, verdicts: [ok], evidence_ref: e.md } }
    - { id: y, actor_role: r, allowed_exits: [done, failed], next_hop: { on: { failed: a } } }
  loop_guards: { max_hops: 10 }
`,
      "upstream-loop.yaml",
    );
    expect(bypass(spec)).toEqual([]);
  });

  it("reports the offending edge once, with an indexed field path", () => {
    const issues = bypass(load("ticket-factory.yaml"));
    const qa = issues.find((i) => i.message.includes("'qa_check -> implement'"));
    expect(qa?.field).toBe("workflow.steps[4].next_hop.on.failed");
  });

  it("leaves every other shipped spec free of the advisory", () => {
    for (const f of readdirSync(DIR).filter((n) => n.endsWith(".yaml") && n !== "ticket-factory.yaml")) {
      expect(bypass(load(f)), f).toEqual([]);
    }
  });
});
