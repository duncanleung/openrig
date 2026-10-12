import { sectionRule, type ContentLine } from "../detail.js";
import type { FleetSnapshot } from "../types.js";

export interface McpRegistryRead {
  version: number;
  servers: Record<string, {
    enabled: boolean;
    config: Record<string, unknown>;
    disabledAt?: string;
    note?: string;
  }>;
}

function transportOf(config: Record<string, unknown>): "http" | "stdio" | "unknown" {
  if (typeof config.url === "string") return "http";
  if (typeof config.command === "string") return "stdio";
  return "unknown";
}

export function mcpLines(snap: FleetSnapshot, width: number): ContentLine[] {
  const reg = snap.mcpRegistry;
  if (reg === undefined) return [{ text: "MCP Servers · loading…" }];
  if (reg === null) return [{ text: "MCP Servers · registry not found" }, { text: "" }, { text: "  Run `rig mcp import` to bootstrap the registry from ~/.claude.json" }];

  const entries = Object.entries(reg.servers).sort(([a], [b]) => a.localeCompare(b));
  const enabledCount = entries.filter(([, e]) => e.enabled).length;
  const disabledCount = entries.length - enabledCount;

  const lines: ContentLine[] = [
    { text: `MCP Servers · ${enabledCount} enabled, ${disabledCount} disabled  (Enter toggles)` },
    { text: "" },
  ];

  for (const [name, entry] of entries) {
    const glyph = entry.enabled ? "●" : "○";
    const status = entry.enabled ? "enabled" : "disabled";
    const transport = transportOf(entry.config);
    const endpoint = typeof entry.config.url === "string" ? entry.config.url : typeof entry.config.command === "string" ? entry.config.command : "";
    const prefix = `  ${glyph} ${name}`;
    const pad = Math.max(2, width - prefix.length - status.length);
    const full = prefix + " ".repeat(pad) + status;
    lines.push({
      text: full,
      action: { type: "act", act: "mcp-toggle", name },
      segs: [
        { text: prefix },
        { text: " ".repeat(pad) + status, token: entry.enabled ? "accent" : "dim" },
      ],
    });
    lines.push({ text: `      ${transport}` });
    if (endpoint) lines.push({ text: `      ${endpoint}` });
    if (!entry.enabled && entry.disabledAt) lines.push({ text: `      since ${entry.disabledAt.slice(0, 10)}` });
    if (entry.note) lines.push({ text: `      ${entry.note}` });
  }
  lines.push({ text: "" });

  lines.push(sectionRule("commands", width));
  lines.push({ text: "  rig mcp list              show all servers" });
  lines.push({ text: "  rig mcp show <name>       show config (--reveal for secrets)" });
  lines.push({ text: "  rig mcp import            import from ~/.claude.json" });
  lines.push({ text: "  rig mcp sync              force sync registry → claude.json" });

  return lines;
}
