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

import { readFileSync, readdirSync } from "fs";
import { resolve, basename } from "path";
import { homedir } from "os";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let jsonlPath = null;

if (args[0] === "--session-id" && args[1]) {
  // Resolve from ~/.claude/projects/ by matching session ID prefix
  const sessionId = args[1];
  const projectsDir = resolve(homedir(), ".claude", "projects");
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

const rawLines = readFileSync(jsonlPath, "utf8").trim().split("\n");

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

// Map tool_use_id → { name, turn } so we can correlate tool results
const pendingToolUse = new Map();
let lineIdx = 0;

for (const line of rawLines) {
  lineIdx++;
  let obj;
  try { obj = JSON.parse(line); } catch { continue; }

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
        if (fp.includes("CLAUDE.md") || fp.includes("AGENTS.md")) {
          claudeMdLoaded.add(fp);
        }
      }

      // CLAUDE.md / AGENTS.md loaded via Skill or direct references
      if (toolName === "Skill") {
        // Skill invocations themselves are relevant to instruction context
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
  if (obj.type === "user" && Array.isArray(obj.message?.content)) {
    let hasHumanText = false;
    for (const c of obj.message.content) {
      if (c.type === "tool_result") {
        if (c.is_error) {
          const pending = c.tool_use_id ? pendingToolUse.get(c.tool_use_id) : null;
          const rawContent = typeof c.content === "string" ? c.content : JSON.stringify(c.content || "");
          // Strip outer quotes if JSON-stringified
          const message = rawContent.replace(/^"|"$/g, "").replace(/\\n/g, " ").slice(0, 150);
          errors.push({
            tool: pending?.name || "unknown",
            message,
            turn: pending?.turn ?? totalTurns,
          });
        }
      } else if (c.type === "text" || c.type === "human_turn_text") {
        hasHumanText = true;
      }
    }
    if (hasHumanText) conversationTurns++;
  }
}

// ── Derive repeated reads ─────────────────────────────────────────────────────

const repeatedReads = Object.entries(readPaths)
  .filter(([, count]) => count > 1)
  .sort((a, b) => b[1] - a[1])
  .map(([path, count]) => ({ path, count }));

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
};

process.stdout.write(JSON.stringify(digest, null, 2) + "\n");
