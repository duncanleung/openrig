import { describe, it, expect } from "vitest";
import { renderTicketFactoryStatus, type TicketFactoryStatusBody } from "../src/commands/ticket-factory.js";

const base: TicketFactoryStatusBody = {
  state: "running", pollIntervalSeconds: 300, capacity: 1, live: 1,
  run: { runId: "run-1", admitted: 2, maxTickets: 3 },
  wallClockPerTicketSeconds: 3600, cooldownSeconds: 3600,
  budget: { tokensPerTicket: "advisory: no session attribution yet", tokenCapPerTicket: 500000 },
  merge: { gate: "all", policy: "auto-low-risk", effective: "human-approval", reason: "merge_gate: all overrides merge_policy: auto-low-risk (explicit approval wins)" },
  failStreak: 0, lastPollAt: null, nextPollAt: null, lastError: null,
};

describe("rig ticket-factory status rendering (RIG-88)", () => {
  it("shows state, cadence, capacity, run budget consumed and the merge precedence", () => {
    const text = renderTicketFactoryStatus(base).join("\n");
    expect(text).toContain("ticket-factory: running");
    expect(text).toContain("every 300s");
    expect(text).toContain("1/1 live");
    expect(text).toContain("2/3 tickets admitted");
    expect(text).toContain("human-approval");
    expect(text).toContain("explicit approval wins");
  });

  it("shows backoff and the last error only when present", () => {
    expect(renderTicketFactoryStatus(base).join("\n")).not.toContain("backoff");
    const text = renderTicketFactoryStatus({ ...base, failStreak: 3, lastError: "linear down" }).join("\n");
    expect(text).toContain("3 consecutive failure(s)");
    expect(text).toContain("linear down");
  });
});
