import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SessionTransport, parseDeliveryGapMs } from "../src/domain/session-transport.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { createFullTestDb } from "./helpers/test-app.js";

// RIG-98: back-to-back sends to one pane must not interleave. The gap (a distinctive 777 ms,
// never the 200 ms paste->Enter delay) is slept inside the serialization domain after a
// successful Enter, only when another send is queued behind.
const GAP = 777;
const IDLE_PANE = "idle prompt\n❯ ";

interface Harness {
  events: string[];
  tmux: TmuxAdapter;
  transport: SessionTransport;
}

describe("send delivery gap (RIG-98)", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let savedEnv: string | undefined;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    savedEnv = process.env.OPENRIG_SEND_DELIVERY_GAP_MS;
    delete process.env.OPENRIG_SEND_DELIVERY_GAP_MS;
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.OPENRIG_SEND_DELIVERY_GAP_MS;
    else process.env.OPENRIG_SEND_DELIVERY_GAP_MS = savedEnv;
    db.close();
  });

  function seed(member: string, rigName = "my-rig") {
    const rig = rigRepo.listRigs().find((r) => r.name === rigName) ?? rigRepo.createRig(rigName);
    const node = rigRepo.addNode(rig.id, member, { role: "worker", runtime: "claude-code" });
    const name = `${member.replace(".", "-")}@${rigName}`;
    const session = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name });
    return name;
  }

  function harness(opts: {
    guarded: boolean;
    deliveryGapMs?: number;
    sendText?: (target: string, text: string, events: string[]) => Promise<TmuxResult>;
    sendKeys?: (target: string, keys: string[], events: string[]) => Promise<TmuxResult>;
  }): Harness {
    const events: string[] = [];
    const tmux = {
      hasSession: async () => true,
      probeSession: async () => ({ state: "present" as const }),
      sendText: async (target: string, text: string) => {
        events.push(`paste:${text}`);
        return opts.sendText ? opts.sendText(target, text, events) : { ok: true as const };
      },
      sendKeys: async (target: string, keys: string[]) => {
        events.push(`enter:${keys.join(",")}`);
        return opts.sendKeys ? opts.sendKeys(target, keys, events) : { ok: true as const };
      },
      capturePaneContent: async () => IDLE_PANE,
      getPaneCommand: async () => null,
    } as unknown as TmuxAdapter;
    if (opts.guarded) {
      db.exec(outboxEntriesSchema.sql);
      db.exec(seatDeliveryGuardSchema.sql);
      (tmux as unknown as { deliveryGuard?: SeatDeliveryGuard }).deliveryGuard =
        new SeatDeliveryGuard(db, (name) => resolveGuardTarget(db, name));
    }
    const transport = new SessionTransport({
      db, rigRepo, sessionRegistry, tmuxAdapter: tmux,
      deliveryGapMs: opts.deliveryGapMs ?? GAP,
      sleep: async (ms) => { events.push(`sleep:${ms}`); await Promise.resolve(); },
    });
    return { events, tmux, transport };
  }

  // Only the events that define the interleave: pastes, Enters, and the gap sleep.
  const shape = (events: string[]) => events.filter((e) => !e.startsWith("sleep:") || e === `sleep:${GAP}`);

  const immediate = () => new Promise((resolve) => setTimeout(resolve, 0));

  for (const guarded of [true, false]) {
    const label = guarded ? "guarded" : "unguarded";

    describe(label, () => {
      it("two concurrent sends to one target: paste1, Enter1, gap, paste2, Enter2", async () => {
        const name = seed("dev.impl");
        const { events, transport } = harness({ guarded });
        const [a, b] = await Promise.all([transport.send(name, "A"), transport.send(name, "B")]);
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
        expect(shape(events)).toEqual(["paste:A", "enter:Enter", `sleep:${GAP}`, "paste:B", "enter:Enter"]);
      });

      it("a single send takes no gap sleep", async () => {
        const name = seed("dev.impl");
        const { events, transport } = harness({ guarded });
        await transport.send(name, "A");
        expect(events.filter((e) => e === `sleep:${GAP}`)).toHaveLength(0);
        expect(events).toEqual(["paste:A", "sleep:200", "enter:Enter"]);
      });

      it("three queued sends: a gap between each pair, none after the last", async () => {
        const name = seed("dev.impl");
        const { events, transport } = harness({ guarded });
        await Promise.all([transport.send(name, "A"), transport.send(name, "B"), transport.send(name, "C")]);
        expect(shape(events)).toEqual([
          "paste:A", "enter:Enter", `sleep:${GAP}`,
          "paste:B", "enter:Enter", `sleep:${GAP}`,
          "paste:C", "enter:Enter",
        ]);
      });

      it("a stalled send to one target does not delay a send to another target", async () => {
        const a = seed("dev.a");
        const b = seed("dev.b");
        let releaseA!: () => void;
        const aStalled = new Promise<void>((resolve) => { releaseA = resolve; });
        const { events, transport } = harness({
          guarded,
          sendText: async (target) => { if (target === a) await aStalled; return { ok: true as const }; },
        });
        const first = transport.send(a, "A");
        await immediate();
        const second = await transport.send(b, "B");
        expect(second.ok).toBe(true);
        expect(events).toContain("paste:B");
        releaseA();
        expect((await first).ok).toBe(true);
        // Neither had a queued successor on its own target, so neither slept the gap.
        expect(events.filter((e) => e === `sleep:${GAP}`)).toHaveLength(0);
      });

      it("a failed paste releases the target; the next send runs and no gap follows the failure", async () => {
        const name = seed("dev.impl");
        let calls = 0;
        const { events, transport } = harness({
          guarded,
          sendText: async () => (++calls === 1
            ? { ok: false as const, code: "tmux_error", message: "boom" } as unknown as TmuxResult
            : { ok: true as const }),
        });
        const [a, b] = await Promise.all([transport.send(name, "A"), transport.send(name, "B")]);
        expect(a.ok).toBe(false);
        expect(a.reason).toBe("send_failed");
        expect(b.ok).toBe(true);
        expect(shape(events)).toEqual(["paste:A", "paste:B", "enter:Enter"]);
      });

      it("a failed Enter releases the target; the next send runs and no gap follows the failure", async () => {
        const name = seed("dev.impl");
        let calls = 0;
        const { events, transport } = harness({
          guarded,
          sendKeys: async () => (++calls === 1
            ? { ok: false as const, code: "tmux_error", message: "boom" } as unknown as TmuxResult
            : { ok: true as const }),
        });
        const [a, b] = await Promise.all([transport.send(name, "A"), transport.send(name, "B")]);
        expect(a.reason).toBe("submit_failed");
        expect(b.ok).toBe(true);
        expect(shape(events)).toEqual(["paste:A", "enter:Enter", "paste:B", "enter:Enter"]);
      });

      it("a gap of 0 disables the gap", async () => {
        const name = seed("dev.impl");
        const { events, transport } = harness({ guarded, deliveryGapMs: 0 });
        await Promise.all([transport.send(name, "A"), transport.send(name, "B")]);
        expect(events.filter((e) => e.startsWith("sleep:") && e !== "sleep:200")).toEqual([]);
        expect(events.filter((e) => e.startsWith("paste:") || e.startsWith("enter:")))
          .toEqual(["paste:A", "enter:Enter", "paste:B", "enter:Enter"]);
      });
    });
  }

  it("unguarded: a thrown error releases the per-name chain", async () => {
    const name = seed("dev.impl");
    let calls = 0;
    const { events, transport } = harness({
      guarded: false,
      sendText: async () => { if (++calls === 1) throw new Error("tmux exploded"); return { ok: true as const }; },
    });
    const first = transport.send(name, "A");
    const firstSettled = first.then(() => "resolved", () => "rejected");
    const second = transport.send(name, "B");
    await firstSettled;
    expect((await second).ok).toBe(true);
    expect(events).toContain("paste:B");
    // A later send still runs (chain map is not wedged).
    expect((await transport.send(name, "C")).ok).toBe(true);
  });

  describe("configuration", () => {
    it("parseDeliveryGapMs: default, valid, zero, cap, invalid", () => {
      expect(parseDeliveryGapMs(undefined)).toBe(500);
      expect(parseDeliveryGapMs("")).toBe(500);
      expect(parseDeliveryGapMs("250")).toBe(250);
      expect(parseDeliveryGapMs("0")).toBe(0);
      expect(parseDeliveryGapMs("999999")).toBe(10000);
      expect(parseDeliveryGapMs("-5")).toBe(500);
      expect(parseDeliveryGapMs("abc")).toBe(500);
      expect(parseDeliveryGapMs("NaN")).toBe(500);
      expect(parseDeliveryGapMs("Infinity")).toBe(500);
    });

    async function gapSleeps(guarded: boolean, env: string | undefined, dep?: number) {
      const name = seed("dev.impl");
      if (env !== undefined) process.env.OPENRIG_SEND_DELIVERY_GAP_MS = env;
      const events: string[] = [];
      const tmux = {
        hasSession: async () => true, probeSession: async () => ({ state: "present" as const }),
        sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
        capturePaneContent: async () => IDLE_PANE, getPaneCommand: async () => null,
      } as unknown as TmuxAdapter;
      if (guarded) {
        db.exec(outboxEntriesSchema.sql);
        db.exec(seatDeliveryGuardSchema.sql);
        (tmux as unknown as { deliveryGuard?: SeatDeliveryGuard }).deliveryGuard =
          new SeatDeliveryGuard(db, (n) => resolveGuardTarget(db, n));
      }
      const transport = new SessionTransport({
        db, rigRepo, sessionRegistry, tmuxAdapter: tmux,
        ...(dep !== undefined ? { deliveryGapMs: dep } : {}),
        sleep: async (ms) => { events.push(`sleep:${ms}`); },
      });
      await Promise.all([transport.send(name, "A"), transport.send(name, "B")]);
      return events.filter((e) => e !== "sleep:200");
    }

    for (const guarded of [true, false]) {
      it(`env var sets the gap (${guarded ? "guarded" : "unguarded"})`, async () => {
        expect(await gapSleeps(guarded, "321")).toEqual(["sleep:321"]);
      });
      it(`invalid env falls back to 500 (${guarded ? "guarded" : "unguarded"})`, async () => {
        expect(await gapSleeps(guarded, "nonsense")).toEqual(["sleep:500"]);
      });
      it(`env 0 disables the gap (${guarded ? "guarded" : "unguarded"})`, async () => {
        expect(await gapSleeps(guarded, "0")).toEqual([]);
      });
      it(`deps value wins over env (${guarded ? "guarded" : "unguarded"})`, async () => {
        expect(await gapSleeps(guarded, "321", 42)).toEqual(["sleep:42"]);
      });
    }
  });
});
