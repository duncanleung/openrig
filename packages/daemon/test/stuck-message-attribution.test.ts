import { describe, it, expect } from "vitest";
import {
  attributionAllowsAutoEnter,
  classifyStuckAttribution,
  extractComposerVisibleText,
  fingerprintComposerText,
  isCollapsedPasteLabel,
  isOpenRigEnvelopeText,
  isQueueWakeText,
  truncateExcerpt,
} from "../src/domain/stuck-message-attribution.js";

const ENVELOPE = [
  "From: orch.lead@demo",
  "To: dev-impl@demo",
  "Sent: 11-04 22:00Z",
  "---",
  "Please review the PR.",
  "---",
  '↩ Reply: rig send orch.lead@demo "..."',
].join("\n");

const QUEUE_WAKE = [
  "From: queue@system",
  "To: dev-impl@demo",
  "---",
  "Queue handoff: qitem-20261104120000-abcd - check your queue. Summary: do the thing",
  "---",
  '↩ Reply: rig send queue@system "..."',
].join("\n");

function claudeComposer(body: string): string {
  return [
    "──────────────",
    `❯ ${body.split("\n")[0]}`,
    ...body.split("\n").slice(1).map((l) => `  ${l}`),
    "──────────────",
    "  ⏵⏵ accept edits on (shift+tab to cycle)",
  ].join("\n");
}

describe("stuck-message attribution", () => {
  it("recognizes OpenRig From/To envelopes and queue wakes", () => {
    expect(isOpenRigEnvelopeText(ENVELOPE)).toBe(true);
    expect(isQueueWakeText(QUEUE_WAKE)).toBe(true);
    expect(classifyStuckAttribution(ENVELOPE)).toBe("openrig_envelope");
    expect(classifyStuckAttribution(QUEUE_WAKE)).toBe("queue_wake");
    expect(attributionAllowsAutoEnter("openrig_envelope")).toBe(true);
    expect(attributionAllowsAutoEnter("queue_wake")).toBe(true);
  });

  it("treats human drafts as never auto-Enter", () => {
    expect(classifyStuckAttribution("half-written request to the agent")).toBe("human_draft");
    expect(attributionAllowsAutoEnter("human_draft")).toBe(false);
  });

  it("attributes collapsed paste labels only when pasteAttributed", () => {
    const label = "[Pasted text #4 +12 lines]";
    expect(isCollapsedPasteLabel(label)).toBe(true);
    expect(classifyStuckAttribution(label)).toBe("unknown");
    expect(classifyStuckAttribution(label, { pasteAttributed: true })).toBe("collapsed_paste");
    expect(attributionAllowsAutoEnter("collapsed_paste")).toBe(true);
    expect(isCollapsedPasteLabel("[PastedContent2400chars]")).toBe(true);
  });

  it("fingerprints are stable for unchanged text and change when text changes", () => {
    const a = fingerprintComposerText(ENVELOPE);
    const b = fingerprintComposerText(ENVELOPE + "\n");
    const c = fingerprintComposerText(ENVELOPE.replace("Please", "Please now"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("truncates excerpts to ~200 chars", () => {
    const long = "x".repeat(250);
    expect(truncateExcerpt(long).length).toBeLessThanOrEqual(200);
    expect(truncateExcerpt(long).endsWith("…")).toBe(true);
  });

  it("extracts visible composer text from a Claude idle layout", () => {
    const pane = claudeComposer(ENVELOPE);
    const text = extractComposerVisibleText(pane, "claude-code");
    expect(text).toContain("From: orch.lead@demo");
    expect(text).toContain("Please review the PR.");
    expect(classifyStuckAttribution(text!)).toBe("openrig_envelope");
  });

  it("refuses numbered selection prompts as composer text", () => {
    const pane = [
      "❯ 1. Approve this command",
      "  2. Reject",
      "──────────────",
      "  ⏵⏵ accept edits on (shift+tab to cycle)",
    ].join("\n");
    expect(extractComposerVisibleText(pane, "claude-code")).toBeNull();
  });
});
