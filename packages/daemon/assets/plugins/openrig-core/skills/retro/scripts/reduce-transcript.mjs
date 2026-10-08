#!/usr/bin/env node
/**
 * reduce-transcript.mjs — deterministic (non-LLM) pre-reduction script for /retro.
 *
 * Reads a Claude Code JSONL transcript, extracts structured signals, and outputs
 * a JSON digest to stdout. Target: reduce ~39K tokens/seat to ~5-10K tokens/seat.
 *
 * Usage:
 *   node reduce-transcript.mjs <path-to-session.jsonl>
 *   node reduce-transcript.mjs --session-id <session-id>   # resolves path from ~/.claude/projects/
 *
 * Output: JSON digest to stdout.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, basename } from "path";
import { homedir } from "os";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let jsonlPath = null;

if (args[0] === "--session-id" && args[1]) {
  // Resolve from ~/.claude/projects/ by matching session ID prefix
  const sessionId = args[1];
  const projectsDir = resolve(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) {
    process.stderr.write("Error: projects directory not found: " + projectsDir + "\n");
    process.exit(1);
  }
  for (const projectDir of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const dir = resolve(projectsDir, projectDir.name);
    for (const f of readdirSync(dir)) {
      if (f.startsWith(sessionId) && f.endsWith(".jsonl")) {
        jsonlPath = resolve(dir, f);
        break;
      }
    }
    if (jsonlPath) break;
  }
  if (!jsonlPath) {
    process.stderr.write(`Error: no JSONL file found for session ID: ${sessionId}\n`);
    process.exit(1);
  }
} else if (args[0] && !args[0].startsWith("--")) {
  jsonlPath = resolve(args[0]);
} else {
  process.stderr.write("Usage: reduce-transcript.mjs <path.jsonl> | --session-id <id>\n");
  process.exit(1);
}

// ── Parse JSONL ───────────────────────────────────────────────────────────────

let rawLines;
try {
  rawLines = readFileSync(jsonlPath, "utf8").trim().split("\n");
} catch (err) {
  process.stderr.write("Error reading transcript: " + err.message + "\n");
  process.exit(1);
}

// ── Extraction state ──────────────────────────────────────────────────────────

let seat = basename(jsonlPath, ".jsonl"); // fallback: session ID
let totalTurns = 0;                        // assistant messages with content
let conversationTurns = 0;                 // human (non-tool-result) user messages

const toolCounts = {};
const readPaths = {};           // path → count
const reviewFindings = [];      // strings from ReportFindings calls
const handoffEvents = [];       // { type: 'send'|'queue', to, message, turn }
const claudeMdLoaded = new Set();
const errors = [];              // { tool, message, turn }
const irreversibleActions = []; // { command (truncated), kind, turn }

// Per-turn token usage
const turnTokenUsage = [];      // { turn, input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens }
let tokenTotals = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const seenUsageIds = new Set();  // dedupe usage by message.id to avoid multi-line inflation

// Compaction loss tracking
const compactionBoundaries = [];     // turn numbers where compaction occurred
const readPathsBySegment = [{}];     // one map per segment (split by compaction)
let currentSegmentIdx = 0;

// Map tool_use_id → { name, turn } so we can correlate tool results
const pendingToolUse = new Map();
let lineIdx = 0;
let skippedLines = 0;

for (const line of rawLines) {
  lineIdx++;
  let obj;
  try { obj = JSON.parse(line); } catch { if (line.trim()) skippedLines++; continue; }

  // ── Seat name ──────────────────────────────────────────────────────────────
  if (obj.type === "agent-name") {
    const name = obj.agentName || obj.name;
    if (name) seat = name;
    continue;
  }

  // ── Assistant messages ─────────────────────────────────────────────────────
  if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
    const content = obj.message.content;
    const hasAction = content.some(c => c.type === "tool_use" || c.type === "text");
    if (hasAction) totalTurns++;

    // Extract token usage from assistant message (dedupe by message.id)
    const usage = obj.message?.usage;
    const usageId = obj.message?.id ?? obj.requestId;
    if (usage && hasAction && !(usageId && seenUsageIds.has(usageId))) {
      if (usageId) seenUsageIds.add(usageId);
      const turnUsage = {
        turn: totalTurns,
        input_tokens: usage.input_tokens ?? 0,
        output_tokens: usage.output_tokens ?? 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      };
      turnTokenUsage.push(turnUsage);
      tokenTotals.input_tokens += turnUsage.input_tokens;
      tokenTotals.output_tokens += turnUsage.output_tokens;
      tokenTotals.cache_creation_input_tokens += turnUsage.cache_creation_input_tokens;
      tokenTotals.cache_read_input_tokens += turnUsage.cache_read_input_tokens;
    }

    for (const c of content) {
      if (c.type !== "tool_use") continue;

      const toolName = c.name;
      const input = c.input || {};
      toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;

      // Track for error correlation
      if (c.id) pendingToolUse.set(c.id, { name: toolName, turn: totalTurns });

      // Read path tracking
      if (toolName === "Read" && input.file_path) {
        const fp = input.file_path;
        readPaths[fp] = (readPaths[fp] || 0) + 1;
        // Per-segment tracking for compaction loss detection
        const seg = readPathsBySegment[currentSegmentIdx];
        if (!seg[fp]) seg[fp] = { firstTurn: totalTurns, count: 0 };
        seg[fp].count++;
        if (fp.includes("CLAUDE.md") || fp.includes("AGENTS.md")) {
          claudeMdLoaded.add(fp);
        }
      }

      // Handoff events: rig send / rig queue
      if (toolName === "Bash" && typeof input.command === "string") {
        const cmd = input.command;
        const sendMatch = cmd.match(/rig\s+send\s+(\S+)\s+"([^"]*)"/);
        if (sendMatch) {
          handoffEvents.push({ type: "send", to: sendMatch[1], message: sendMatch[2].slice(0, 120), turn: totalTurns });
        }
        const queueMatch = cmd.match(/rig\s+queue\s+(create|update|assign)\b/);
        if (queueMatch) {
          handoffEvents.push({ type: "queue", operation: queueMatch[1], command: cmd.slice(0, 120), turn: totalTurns });
        }

        // Irreversible / public action detection
        const irreversiblePatterns = [
          { re: /\bgit\s+push\b/, kind: "git-push" },
          { re: /\bgit\s+push\s+--force\b|\bgit\s+push\s+-f\b/, kind: "git-force-push" },
          { re: /\bgh\s+release\s+create\b/, kind: "release-create" },
          { re: /\bgh\s+pr\s+merge\b/, kind: "pr-merge" },
          { re: /\bgh\s+pr\s+comment\b/, kind: "pr-comment" },
          { re: /\bgh\s+pr\s+review\b/, kind: "pr-review" },
          { re: /\bgh\s+api\b.*\b(POST|PUT|PATCH|DELETE)\b/i, kind: "gh-api-write" },
          { re: /\bgit\s+reset\s+--hard\b/, kind: "git-reset-hard" },
          { re: /\bgit\s+branch\s+-[dD]\b/, kind: "branch-delete" },
          { re: /\bgit\s+clean\s+-f\b/, kind: "git-clean" },
          { re: /\brm\s+-rf?\s/, kind: "rm-destructive" },
          { re: /\bnpm\s+publish\b|\bpnpm\s+publish\b/, kind: "npm-publish" },
        ];
        if (!/--dry-run/.test(cmd)) {
          for (const { re, kind } of irreversiblePatterns) {
            if (re.test(cmd)) {
              irreversibleActions.push({ command: cmd.slice(0, 200), kind, turn: totalTurns });
            }
          }
        }
      }

      // ReportFindings: extract finding summaries
      if (toolName === "ReportFindings" && Array.isArray(input.findings)) {
        for (const f of input.findings) {
          const text = [f.summary, f.short_summary, f.failure_scenario]
            .filter(Boolean)
            .join(" | ")
            .slice(0, 200);
          if (text) reviewFindings.push(text);
        }
      }
    }
  }

  // ── User messages (tool results + human turns) ─────────────────────────────
  if (obj.type === "user" && obj.message) {
    const content = obj.message.content;

    // Detect compaction boundary — content can be a plain string or an array
    const rawText = typeof content === "string" ? content : "";
    if (rawText.includes("continued from a previous conversation that ran out of context")
        || rawText.includes("Summary below covers the earlier portion")) {
      compactionBoundaries.push(totalTurns);
      currentSegmentIdx++;
      readPathsBySegment.push({});
    }

    if (Array.isArray(content)) {
      let hasHumanText = false;
      for (const c of content) {
        if (c.type === "tool_result") {
          if (c.is_error) {
            const pending = c.tool_use_id ? pendingToolUse.get(c.tool_use_id) : null;
            const rawContent = typeof c.content === "string" ? c.content
              : Array.isArray(c.content) ? c.content.map(b => typeof b === "string" ? b : b?.type === "text" ? b.text ?? "" : JSON.stringify(b)).join(" ")
              : JSON.stringify(c.content || "");
            const message = rawContent.replace(/\\n/g, " ").slice(0, 150);
            errors.push({
              tool: pending?.name || "unknown",
              message,
              turn: pending?.turn ?? totalTurns,
            });
          }
        } else if (c.type === "text" || c.type === "human_turn_text") {
          hasHumanText = true;
          // Also check array-form text for compaction markers
          const text = typeof c.text === "string" ? c.text : "";
          if (text.includes("continued from a previous conversation that ran out of context")
              || text.includes("Summary below covers the earlier portion")) {
            if (!compactionBoundaries.includes(totalTurns)) {
              compactionBoundaries.push(totalTurns);
              currentSegmentIdx++;
              readPathsBySegment.push({});
            }
          }
        }
      }
      if (hasHumanText) conversationTurns++;
    } else if (rawText) {
      conversationTurns++;
    }
  }
}

// ── Derive repeated reads ─────────────────────────────────────────────────────

const repeatedReads = Object.entries(readPaths)
  .filter(([, count]) => count > 2)
  .sort((a, b) => b[1] - a[1])
  .map(([path, count]) => ({ path, count }));

// ── Derive compaction losses ─────────────────────────────────────────────────
// A file read in segment N and re-read in segment N+1 is a potential compaction loss.
// Exclude CLAUDE.md / AGENTS.md — those are always re-read after compaction by design.

const compactionLosses = [];
for (let s = 1; s < readPathsBySegment.length; s++) {
  const prev = readPathsBySegment[s - 1];
  const curr = readPathsBySegment[s];
  for (const [path, info] of Object.entries(curr)) {
    if (/CLAUDE\.md|AGENTS\.md|\.ai\/compact-checkpoint/i.test(path)) continue;
    if (prev[path]) {
      compactionLosses.push({
        path,
        preCompactTurn: prev[path].firstTurn,
        postCompactTurn: info.firstTurn,
        compactionTurn: compactionBoundaries[s - 1] || null,
      });
    }
  }
}

// ── Build digest ──────────────────────────────────────────────────────────────

const digest = {
  seat,
  transcriptPath: jsonlPath,
  totalTurns,
  conversationTurns,
  toolCalls: toolCounts,
  repeatedReads,
  reviewFindings,
  handoffEvents,
  claudeMdLoaded: [...claudeMdLoaded],
  errors,
  irreversibleActions,
  compactionBoundaries,
  compactionLosses,
  turnTokenUsage,
  tokenTotals,
  skippedLines,
};

if (skippedLines > 0) {
  process.stderr.write(`warning: ${skippedLines} malformed JSONL line(s) skipped in ${jsonlPath}\n`);
}

process.stdout.write(JSON.stringify(digest, null, 2) + "\n");
