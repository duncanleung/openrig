#!/usr/bin/env node
// RIG-126 — compare context growth in Claude Code session JSONL files before and after the
// post-tool-truncate hook (RIG-125) was activated. Read-only. Bytes are a proxy: the Anthropic
// API gives no per-turn token rate (RIG-124), so this reports bytes per assistant turn.
//
// Usage: node scripts/measure-context-growth.mjs --activated <ISO time> [--json] <session.jsonl>...
import { readFileSync } from "node:fs";

const MARKER = "bytes by post-tool-truncate";
const BIG = 8192;

export function resultBytes(content) {
  if (typeof content === "string") return Buffer.byteLength(content);
  if (Array.isArray(content)) return content.reduce((n, c) => n + resultBytes(c?.text ?? c?.content ?? ""), 0);
  return 0;
}

const empty = () => ({ turns: 0, lineBytes: 0, toolResults: 0, toolResultBytes: 0, overCap: 0, truncated: 0 });

/** Split one session's records at `activatedMs` and total each side. */
export function analyze(text, activatedMs) {
  const side = { before: empty(), after: empty() };
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { skipped++; continue; }
    const at = Date.parse(rec.timestamp ?? "");
    if (!Number.isFinite(at)) { skipped++; continue; }
    const s = at >= activatedMs ? side.after : side.before;
    s.lineBytes += Buffer.byteLength(line);
    if (rec.type === "assistant") s.turns++;
    const parts = rec.type === "user" && Array.isArray(rec.message?.content) ? rec.message.content : [];
    for (const p of parts) {
      if (p?.type !== "tool_result") continue;
      const n = resultBytes(p.content);
      s.toolResults++;
      s.toolResultBytes += n;
      if (n > BIG) s.overCap++;
      if (typeof p.content === "string" ? p.content.includes(MARKER) : JSON.stringify(p.content ?? "").includes(MARKER)) s.truncated++;
    }
  }
  return { ...side, skipped };
}

const per = (n, d) => (d > 0 ? Math.round(n / d) : null);
export function summarize(t) {
  return { ...t, toolResultBytesPerTurn: per(t.toolResultBytes, t.turns), lineBytesPerTurn: per(t.lineBytes, t.turns) };
}

export function merge(list) {
  const out = empty();
  for (const t of list) for (const k of Object.keys(out)) out[k] += t[k];
  return out;
}

function main(argv) {
  const files = [];
  let activated = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--activated") activated = argv[++i];
    else if (argv[i] === "--json") json = true;
    else files.push(argv[i]);
  }
  const ms = Date.parse(activated ?? "");
  if (!Number.isFinite(ms) || files.length === 0) {
    console.error("usage: measure-context-growth.mjs --activated <ISO time> [--json] <session.jsonl>...");
    return 2;
  }
  const per_file = files.map((f) => ({ file: f, ...analyze(readFileSync(f, "utf8"), ms) }));
  const before = summarize(merge(per_file.map((r) => r.before)));
  const after = summarize(merge(per_file.map((r) => r.after)));
  const delta = before.toolResultBytesPerTurn && after.toolResultBytesPerTurn
    ? Math.round((1 - after.toolResultBytesPerTurn / before.toolResultBytesPerTurn) * 1000) / 10 : null;
  const report = { activated, sessions: files.length, before, after, toolResultBytesPerTurnChangePercent: delta,
    note: "Bytes per assistant turn is a proxy. Compare sessions with a similar tool mix; one session is not a baseline." };
  if (json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`activated ${activated}; ${files.length} session file(s)`);
    for (const [name, r] of [["before", before], ["after", after]]) {
      console.log(`${name.padEnd(6)} turns=${r.turns} tool-results=${r.toolResults} (${r.overCap} over ${BIG}B, ${r.truncated} cut by hook) tool-result-bytes/turn=${r.toolResultBytesPerTurn} line-bytes/turn=${r.lineBytesPerTurn}`);
    }
    console.log(`tool-result bytes/turn change: ${delta === null ? "n/a" : delta + "%"} (positive = smaller after)`);
    console.log(report.note);
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
