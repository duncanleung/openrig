/**
 * Cron schedule math (RIG-84). Pure: no timers, no I/O, no clock. Callers pass `now`.
 *
 * Specs, evaluated in the daemon's LOCAL timezone:
 *   daily HH:MM
 *   weekly <sun|mon|tue|wed|thu|fri|sat> HH:MM
 * Plain 5-field cron expressions are not supported. Daily and weekly cover the first job and
 * keep the math small enough to test fully without a dependency.
 *
 * DST: a slot is built from local calendar fields, so it follows the wall clock.
 *   - Spring forward: a slot inside the skipped hour (for example 02:30) fires at the first
 *     valid instant after the gap (03:30), once.
 *   - Fall back: a slot inside the repeated hour fires at its first occurrence, once.
 * A calendar day always yields exactly one daily slot.
 */

export type ScheduleSpec =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ScheduleParseError extends Error {}

export function parseSchedule(spec: string): ScheduleSpec {
  if (typeof spec !== "string") throw new ScheduleParseError("schedule must be a string");
  const parts = spec.trim().toLowerCase().split(/\s+/);
  if (parts[0] === "daily" && parts.length === 2) {
    const t = parseTime(parts[1]!);
    return { kind: "daily", ...t };
  }
  if (parts[0] === "weekly" && parts.length === 3) {
    const weekday = WEEKDAYS.indexOf(parts[1] as (typeof WEEKDAYS)[number]);
    if (weekday < 0) throw new ScheduleParseError(`unknown weekday "${parts[1]}" (use sun..sat)`);
    return { kind: "weekly", weekday, ...parseTime(parts[2]!) };
  }
  throw new ScheduleParseError(`unsupported schedule "${spec}" (use "daily HH:MM" or "weekly <sun..sat> HH:MM")`);
}

function parseTime(text: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(text);
  if (!m) throw new ScheduleParseError(`invalid time "${text}" (use 24-hour HH:MM)`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Slot on the local calendar day `dayOffset` days from `now`'s local day, or null when the weekday does not match. */
function slotOnDay(spec: ScheduleSpec, now: Date, dayOffset: number): Date | null {
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate() + dayOffset;
  if (spec.kind === "weekly" && new Date(y, mo, d, 12).getDay() !== spec.weekday) return null;
  return new Date(y, mo, d, spec.hour, spec.minute, 0, 0);
}

/** The latest slot at or before `now`. */
export function previousSlot(spec: ScheduleSpec | string, now: Date): Date {
  const s = typeof spec === "string" ? parseSchedule(spec) : spec;
  for (let back = 0; back <= 8; back++) {
    const slot = slotOnDay(s, now, -back);
    if (slot && slot.getTime() <= now.getTime()) return slot;
  }
  throw new Error("unreachable: no slot within 8 days");
}

/** The earliest slot strictly after `now`. */
export function nextSlot(spec: ScheduleSpec | string, now: Date): Date {
  const s = typeof spec === "string" ? parseSchedule(spec) : spec;
  for (let ahead = 0; ahead <= 8; ahead++) {
    const slot = slotOnDay(s, now, ahead);
    if (slot && slot.getTime() > now.getTime()) return slot;
  }
  throw new Error("unreachable: no slot within 8 days");
}
