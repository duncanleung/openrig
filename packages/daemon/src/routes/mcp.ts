import { existsSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";

function registryPath(): string {
  const home = process.env.OPENRIG_HOME || process.env.RIGGED_HOME || join(homedir(), ".openrig");
  return join(home, "mcp-registry.json");
}

function claudeJsonPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR || homedir();
  return join(dir, ".claude.json");
}

interface McpRegistryEntry {
  enabled: boolean;
  config: Record<string, unknown>;
  disabledAt?: string;
  note?: string;
}

interface McpRegistryFile {
  version: number;
  servers: Record<string, McpRegistryEntry>;
}

function readRegistry(): McpRegistryFile {
  const p = registryPath();
  if (!existsSync(p)) return { version: 1, servers: {} };
  return JSON.parse(readFileSync(p, "utf-8"));
}

function writeSecure(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { mode: 0o600 });
}

function syncToClaudeJson(registry: McpRegistryFile): void {
  const p = claudeJsonPath();
  const doc: Record<string, unknown> = existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : {};
  const current = (doc.mcpServers ?? {}) as Record<string, unknown>;
  const next = { ...current };
  for (const [name, entry] of Object.entries(registry.servers)) {
    if (entry.enabled) next[name] = entry.config;
    else if (name in next) delete next[name];
  }
  doc.mcpServers = next;
  writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
}

export const mcpRoutes = new Hono();

mcpRoutes.get("/registry", (c) => {
  try {
    return c.json(readRegistry());
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

mcpRoutes.post("/toggle/:name", async (c) => {
  const name = c.req.param("name");
  try {
    const registry = readRegistry();
    const entry = registry.servers[name];
    if (!entry) return c.json({ error: `MCP server "${name}" is not in the registry.` }, 404);
    entry.enabled = !entry.enabled;
    if (entry.enabled) delete entry.disabledAt;
    else entry.disabledAt = new Date().toISOString();
    writeSecure(registryPath(), JSON.stringify(registry, null, 2) + "\n");
    syncToClaudeJson(registry);
    return c.json({ name, enabled: entry.enabled });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
