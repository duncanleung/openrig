import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nextSlot, parseSchedule, previousSlot, ScheduleParseError } from "../src/domain/cron-schedule.js";

// RIG-84 — pure schedule math. The tests pin TZ so DST cases do not depend on the machine.

const originalTz = process.env["TZ"];
function useTz(tz: string) {
  beforeAll(() => { process.env["TZ"] = tz; });
  afterAll(() => {
    if (originalTz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = originalTz;
  });
}
const iso = (d: Date) => d.toISOString();

describe("parseSchedule", () => {
  it("parses daily and weekly specs, case and spacing tolerant", () => {
    expect(parseSchedule("daily 06:00")).toEqual({ kind: "daily", hour: 6, minute: 0 });
    expect(parseSchedule("  Daily   23:59 ")).toEqual({ kind: "daily", hour: 23, minute: 59 });
    expect(parseSchedule("weekly sun 06:30")).toEqual({ kind: "weekly", weekday: 0, hour: 6, minute: 30 });
    expect(parseSchedule("weekly SAT 00:00")).toEqual({ kind: "weekly", weekday: 6, hour: 0, minute: 0 });
  });

  it.each(["", "daily", "daily 6:00", "daily 24:00", "daily 06:60", "weekly funday 06:00", "weekly 06:00", "*/5 * * * *", "0 6 * * *", "hourly 06:00"])(
    "rejects %j",
    (spec) => { expect(() => parseSchedule(spec)).toThrow(ScheduleParseError); },
  );

  it("rejects a non-string", () => {
    expect(() => parseSchedule(undefined as unknown as string)).toThrow(ScheduleParseError);
  });
});

describe("slot math (America/Los_Angeles)", () => {
  useTz("America/Los_Angeles");

  it("applies the pinned timezone", () => {
    expect(new Date("2026-03-08T10:30:00Z").getHours()).toBe(3);
  });

  it("daily: previous slot is today once the time has passed, yesterday before it", () => {
    // 2026-10-15 06:00 PDT = 13:00Z
    expect(iso(previousSlot("daily 06:00", new Date("2026-10-15T13:00:01Z")))).toBe("2026-10-15T13:00:00.000Z");
    expect(iso(previousSlot("daily 06:00", new Date("2026-10-15T12:59:59Z")))).toBe("2026-10-14T13:00:00.000Z");
  });

  it("previousSlot includes now; nextSlot excludes it", () => {
    const at = new Date("2026-10-15T13:00:00Z");
    expect(iso(previousSlot("daily 06:00", at))).toBe("2026-10-15T13:00:00.000Z");
    expect(iso(nextSlot("daily 06:00", at))).toBe("2026-10-16T13:00:00.000Z");
  });

  it("crosses month and year boundaries", () => {
    // 2027-01-01 00:30 PST = 08:30Z; the previous 06:00 slot is Dec 31.
    expect(iso(previousSlot("daily 06:00", new Date("2027-01-01T08:30:00Z")))).toBe("2026-12-31T14:00:00.000Z");
    expect(iso(nextSlot("daily 23:00", new Date("2026-12-31T20:00:00Z")))).toBe("2027-01-01T07:00:00.000Z");
  });

  it("weekly: finds the matching weekday, up to a week back or ahead", () => {
    // 2026-10-15 is a Thursday. Sunday 06:00 PDT = 13:00Z.
    const thu = new Date("2026-10-15T20:00:00Z");
    expect(iso(previousSlot("weekly sun 06:00", thu))).toBe("2026-10-11T13:00:00.000Z");
    expect(iso(nextSlot("weekly sun 06:00", thu))).toBe("2026-10-18T13:00:00.000Z");
    // Same weekday, time not yet reached: previous is last week, next is today.
    const thuMorning = new Date("2026-10-15T10:00:00Z");
    expect(iso(previousSlot("weekly thu 06:00", thuMorning))).toBe("2026-10-08T13:00:00.000Z");
    expect(iso(nextSlot("weekly thu 06:00", thuMorning))).toBe("2026-10-15T13:00:00.000Z");
  });

  it("spring forward: a slot in the skipped hour fires once, at the first valid instant", () => {
    // 2026-03-08 02:00-03:00 does not exist. Daily 02:30 lands on 03:30 PDT = 10:30Z.
    expect(iso(previousSlot("daily 02:30", new Date("2026-03-08T10:30:00Z")))).toBe("2026-03-08T10:30:00.000Z");
    expect(iso(previousSlot("daily 02:30", new Date("2026-03-08T10:29:00Z")))).toBe("2026-03-07T10:30:00.000Z");
    // One slot per calendar day across the change: Mar 7 (PST), Mar 8 (gap), Mar 9 (PDT).
    const slots: string[] = [];
    let cursor = new Date("2026-03-07T00:00:00Z");
    for (let i = 0; i < 3; i++) {
      const slot = nextSlot("daily 02:30", cursor);
      slots.push(iso(slot));
      cursor = slot;
    }
    expect(slots).toEqual(["2026-03-07T10:30:00.000Z", "2026-03-08T10:30:00.000Z", "2026-03-09T09:30:00.000Z"]);
  });

  it("fall back: a slot in the repeated hour fires once, at its first occurrence", () => {
    // 2026-11-01 01:30 happens at 08:30Z (PDT) and again at 09:30Z (PST).
    expect(iso(previousSlot("daily 01:30", new Date("2026-11-01T09:45:00Z")))).toBe("2026-11-01T08:30:00.000Z");
    expect(iso(nextSlot("daily 01:30", new Date("2026-11-01T08:30:00Z")))).toBe("2026-11-02T09:30:00.000Z");
  });

  it("a daily wall-clock slot is 23 or 25 hours apart across DST, not 24", () => {
    const a = nextSlot("daily 06:00", new Date("2026-03-06T20:00:00Z"));
    const b = nextSlot("daily 06:00", a);
    expect(iso(a)).toBe("2026-03-07T14:00:00.000Z");
    expect(iso(b)).toBe("2026-03-08T13:00:00.000Z");
    expect(b.getTime() - a.getTime()).toBe(23 * 3600_000);
  });
});

describe("slot math (UTC)", () => {
  useTz("UTC");

  it("uses the process timezone", () => {
    expect(iso(nextSlot("daily 06:00", new Date("2026-10-15T07:00:00Z")))).toBe("2026-10-16T06:00:00.000Z");
    expect(iso(previousSlot("weekly mon 12:15", new Date("2026-10-15T07:00:00Z")))).toBe("2026-10-12T12:15:00.000Z");
  });
});
