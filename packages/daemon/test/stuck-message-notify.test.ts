import { describe, it, expect, vi } from "vitest";
import {
  makeStuckNotifyHook,
  readStuckNotifyConfig,
  stuckNotifyPayload,
  STUCK_SWEEP_NOTIFY_URL_ENV,
  STUCK_SWEEP_NOTIFY_BEARER_ENV,
} from "../src/domain/stuck-message-notify.js";
import type { StuckSweepItem } from "../src/domain/stuck-message-sweeper.js";

const ITEM: StuckSweepItem = {
  rig: "alpha",
  logicalId: "dev.impl",
  session: "dev-impl@alpha",
  runtime: "claude-code",
  action: "needs_human",
  attribution: "human_draft",
  unchangedMs: 90_000,
  excerpt: "half-written",
  detail: "not an OpenRig envelope",
};

describe("stuck-message notify hook", () => {
  it("reads URL and bearer from env only", () => {
    expect(readStuckNotifyConfig({})).toBeNull();
    expect(readStuckNotifyConfig({ [STUCK_SWEEP_NOTIFY_URL_ENV]: " https://hooks.example/x " })).toEqual({
      url: "https://hooks.example/x",
      bearer: undefined,
    });
    expect(readStuckNotifyConfig({
      [STUCK_SWEEP_NOTIFY_URL_ENV]: "https://hooks.example/x",
      [STUCK_SWEEP_NOTIFY_BEARER_ENV]: "secret-token",
    })).toEqual({ url: "https://hooks.example/x", bearer: "secret-token" });
  });

  it("maps actions to auto_fixed / needs_human in the payload", () => {
    expect(stuckNotifyPayload(ITEM).action).toBe("needs_human");
    expect(stuckNotifyPayload({ ...ITEM, action: "auto_enter_verified", verified: true }).action).toBe("auto_fixed");
  });

  it("POSTs JSON with an optional bearer and never throws on fetch failure", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const hook = makeStuckNotifyHook({
      [STUCK_SWEEP_NOTIFY_URL_ENV]: "https://hooks.example/x",
      [STUCK_SWEEP_NOTIFY_BEARER_ENV]: "tok",
    }, fetchImpl as never);
    expect(hook).toBeTypeOf("function");
    await hook!(ITEM);
    expect(fetchImpl).toHaveBeenCalledWith("https://hooks.example/x", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ authorization: "Bearer tok" }),
    }));

    const failing = vi.fn(async () => { throw new Error("network"); });
    const soft = makeStuckNotifyHook({ [STUCK_SWEEP_NOTIFY_URL_ENV]: "https://hooks.example/x" }, failing as never);
    await expect(soft!(ITEM)).resolves.toBeUndefined();
  });
});
