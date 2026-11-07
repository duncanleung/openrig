// Stuck-message sweeper — pure detection helpers for attributing composer text to an
// OpenRig delivery (envelope / queue-wake / collapsed paste) vs a human draft.
// Reuses the From/To envelope shape from pane-envelope.ts and the collapsed-paste
// labels that transport.verify_input_box / submitOnly already recognize.
import { createHash } from "node:crypto";
import {
  COMPOSER_COLLAPSED_PASTE_PATTERN,
  composerPromptClassForRuntime,
  composerSelectionPrefixPattern,
  findComposerInputLineIndex,
  stripComposerPromptGlyph,
} from "./composer-prompts.js";

/** Composer text must stay unchanged at least this long across two observations. */
export const DEFAULT_STUCK_GRACE_MS = 60_000;

/** Excerpt length for human-readable reports and notify payloads. */
export const STUCK_EXCERPT_MAX = 200;

/** Codex collapses a large paste into this opaque label (session-transport). */
export const CODEX_COLLAPSED_PASTE_PATTERN = /^\[PastedContent\d+chars\]$/;

/** OpenRig's From/To messaging envelope header (byte-identical to wrapPaneEnvelope). */
export const OPENRIG_ENVELOPE_HEADER =
  /^From: [^\n]+\nTo: [^\n]+\n(?:Sent: [^\n]+\n)?---\n/;

/** Queue wake body after the envelope (queue-nudge-text.ts). */
export const QUEUE_HANDOFF_BODY = /(?:^|\n)Queue handoff: /;

export type StuckAttribution =
  | "openrig_envelope"
  | "queue_wake"
  | "collapsed_paste"
  | "human_draft"
  | "empty"
  | "unknown";

export type StuckAction =
  | "auto_enter"
  | "auto_enter_verified"
  | "auto_enter_failed"
  | "needs_human"
  | "skipped_busy"
  | "skipped_prompt"
  | "skipped_typing_guard"
  | "skipped_grace"
  | "cleared"
  | "unobserved";

/** Stable fingerprint of the visible composer text (spaces collapsed within lines). */
export function fingerprintComposerText(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
  return `sha256:${createHash("sha256").update(normalized).digest("hex")}`;
}

export function truncateExcerpt(text: string, max = STUCK_EXCERPT_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** True when the visible composer text carries OpenRig's From/To envelope. */
export function isOpenRigEnvelopeText(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\s*[❯›»]\s?/, "");
  return OPENRIG_ENVELOPE_HEADER.test(normalized);
}

/** True when the text is (or contains) a queue-handoff wake body. */
export function isQueueWakeText(text: string): boolean {
  const normalized = text.replace(/\r\n/g, "\n").replace(/^\s*[❯›»]\s?/, "");
  return QUEUE_HANDOFF_BODY.test(normalized) || /^Queue handoff: /.test(normalized.trim());
}

/** True when the composer holds only Claude's or Codex's collapsed-paste label. */
export function isCollapsedPasteLabel(text: string): boolean {
  const lines = text.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length !== 1) return false;
  const body = lines[0]!.replace(/^[❯›»]\s?/, "");
  return COMPOSER_COLLAPSED_PASTE_PATTERN.test(body) || CODEX_COLLAPSED_PASTE_PATTERN.test(body);
}

/**
 * Attribute stuck composer text to an OpenRig delivery or refuse as a human draft.
 * Collapsed pastes are only auto-safe when `pasteAttributed` is true (a delivery
 * attempt on this occupant correlates, or the paste label is otherwise proven ours).
 */
export function classifyStuckAttribution(
  text: string | null | undefined,
  opts: { pasteAttributed?: boolean } = {},
): StuckAttribution {
  if (text == null) return "unknown";
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return "empty";
  if (isCollapsedPasteLabel(trimmed)) {
    return opts.pasteAttributed ? "collapsed_paste" : "unknown";
  }
  if (isOpenRigEnvelopeText(trimmed)) {
    return isQueueWakeText(trimmed) ? "queue_wake" : "openrig_envelope";
  }
  if (isQueueWakeText(trimmed)) return "queue_wake";
  // Anything else in the box is treated as a human (or foreign) draft — never auto-Enter.
  return "human_draft";
}

/** Whether this attribution is safe for a single guarded auto-Enter. */
export function attributionAllowsAutoEnter(attribution: StuckAttribution): boolean {
  return attribution === "openrig_envelope"
    || attribution === "queue_wake"
    || attribution === "collapsed_paste";
}

/**
 * Extract the visible composer draft from a pane capture, reusing the same
 * prompt-glyph / closing-rule region that `hasExpectedStagedText` and
 * `readComposerOccupancy` already trust. Returns null when the composer cannot
 * be recognized (permission selectors, mid-turn chrome, missing marker).
 */
export function extractComposerVisibleText(
  pane: string | null | undefined,
  runtime: string | null = null,
): string | null {
  if (!pane?.trim()) return null;
  const promptClass = composerPromptClassForRuntime(runtime);
  const lines = pane.replace(/\r\n/g, "\n").split("\n");
  const inputAt = findComposerInputLineIndex(lines, promptClass);
  if (inputAt < 0) return null;
  const inputLine = lines[inputAt]!.trimStart();
  if (composerSelectionPrefixPattern(promptClass).test(inputLine)) return null;
  let regionEnd = lines.length;
  for (let i = inputAt + 1; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.length >= 10 && /^[─═-]+$/.test(t)) { regionEnd = i; break; }
  }
  const regionLines = lines.slice(inputAt, regionEnd);
  if (regionLines.length === 0) return null;
  // stripComposerPromptGlyph leaves the space after the glyph; trim so collapsed-paste
  // labels and envelope headers match their canonical forms.
  const first = stripComposerPromptGlyph(regionLines[0]!.trimStart(), promptClass).replace(/^\s+/, "");
  // Continuation rows in Claude's box are indented under the prompt glyph.
  const rest = regionLines.slice(1).map((line) => {
    const trimmed = line.trimEnd();
    return trimmed.replace(/^\s{2}/, "");
  });
  const text = [first, ...rest].join("\n").replace(/\s+$/u, "");
  // Ghost "Try …" suggestions and the queued-message placeholder are not stuck input.
  if (!text.trim()) return "";
  if (/^Try "/.test(text.trim()) || /^Press up to edit queued messages$/i.test(text.trim())) return "";
  return text;
}
