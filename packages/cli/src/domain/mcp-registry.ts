import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeTextAtomically } from "../atomic-text-write.js";

export type McpServerConfig = Record<string, unknown>;

export interface McpRegistryEntry {
  enabled: boolean;
  config: McpServerConfig;
  disabledAt?: string;
  note?: string;
}

export interface McpRegistryFile {
  version: 1;
  servers: Record<string, McpRegistryEntry>;
}

export interface McpRegistryPaths {
  registryPath: string;
  claudeJsonPath: string;
}

export interface SyncResult {
  written: string[];
  removed: string[];
}

export interface ImportResult {
  added: string[];
  skipped: string[];
}

/** Resolve default file locations from the environment. */
export function resolveMcpPaths(env: NodeJS.ProcessEnv = process.env): McpRegistryPaths {
  // Inline RIGGED_HOME fallback to match readOpenRigEnv("OPENRIG_HOME", "RIGGED_HOME")
  // in openrig-compat.ts. Inlined because getOpenRigHome() reads process.env directly.
  const openrigHome = env.OPENRIG_HOME || env.RIGGED_HOME || join(homedir(), ".openrig");
  // claude.json lives at the root of the Claude config dir (HOME by default), not inside .claude/.
  const claudeDir = env.CLAUDE_CONFIG_DIR || homedir();
  return {
    registryPath: join(openrigHome, "mcp-registry.json"),
    claudeJsonPath: join(claudeDir, ".claude.json"),
  };
}

/** Classify a server config as http or stdio. */
export function transportOf(config: McpServerConfig): "http" | "stdio" | "unknown" {
  if (typeof config.url === "string") return "http";
  if (typeof config.command === "string") return "stdio";
  return "unknown";
}

const MASKED_KEYS = ["headers", "env"] as const;

/** Return a copy of the config with header and env values masked as ***. */
export function redactConfig(config: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = { ...config };
  for (const key of MASKED_KEYS) {
    const value = out[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.keys(value).map((k) => [k, "***"]));
    }
  }
  return out;
}

function parseJsonObjectFile(path: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`${label} at ${path} is not valid JSON. Fix the file or delete it to reset.\n${(err as Error).message}`);
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} at ${path} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** File-backed MCP server registry. Pure file I/O; no daemon dependency. */
export class McpRegistry {
  constructor(readonly paths: McpRegistryPaths = resolveMcpPaths()) {}

  read(): McpRegistryFile {
    if (!existsSync(this.paths.registryPath)) return { version: 1, servers: {} };
    const raw = parseJsonObjectFile(this.paths.registryPath, "MCP registry") as Partial<McpRegistryFile>;
    return { version: 1, servers: raw.servers && typeof raw.servers === "object" && !Array.isArray(raw.servers) ? raw.servers as Record<string, McpRegistryEntry> : {} };
  }

  write(registry: McpRegistryFile): void {
    mkdirSync(dirname(this.paths.registryPath), { recursive: true, mode: 0o700 });
    writeTextAtomically(this.paths.registryPath, JSON.stringify(registry, null, 2) + "\n", "MCP registry");
    chmodSync(this.paths.registryPath, 0o600);
  }

  /** Read the whole claude.json, or an empty object when it does not exist. */
  readClaudeJson(): Record<string, unknown> {
    if (!existsSync(this.paths.claudeJsonPath)) return {};
    return parseJsonObjectFile(this.paths.claudeJsonPath, "claude.json");
  }

  readClaudeMcpServers(): Record<string, McpServerConfig> {
    const servers = this.readClaudeJson().mcpServers;
    return servers && typeof servers === "object" ? (servers as Record<string, McpServerConfig>) : {};
  }

  /** Replace mcpServers in claude.json, preserving every other top-level key. */
  writeClaudeMcpServers(servers: Record<string, McpServerConfig>): void {
    const doc = this.readClaudeJson();
    doc.mcpServers = servers;
    writeTextAtomically(this.paths.claudeJsonPath, JSON.stringify(doc, null, 2) + "\n", "claude.json");
  }

  list(): Array<{ name: string } & McpRegistryEntry> {
    return Object.entries(this.read().servers)
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): McpRegistryEntry {
    const entry = this.read().servers[name];
    if (!entry) throw new Error(`MCP server "${name}" is not in the registry. Run \`rig mcp import\` or check \`rig mcp list\`.`);
    return entry;
  }

  /** Add every claude.json server missing from the registry, as enabled. */
  import(): ImportResult {
    const registry = this.read();
    const result: ImportResult = { added: [], skipped: [] };
    for (const [name, config] of Object.entries(this.readClaudeMcpServers())) {
      if (registry.servers[name]) result.skipped.push(name);
      else {
        registry.servers[name] = { enabled: true, config };
        result.added.push(name);
      }
    }
    if (result.added.length > 0) this.write(registry);
    return result;
  }

  enable(name: string): SyncResult {
    const registry = this.read();
    const entry = registry.servers[name];
    if (!entry) throw new Error(`MCP server "${name}" is not in the registry. Run \`rig mcp import\` or check \`rig mcp list\`.`);
    entry.enabled = true;
    delete entry.disabledAt;
    this.write(registry);
    return this.sync();
  }

  disable(name: string, now: Date = new Date()): SyncResult {
    const registry = this.read();
    const entry = registry.servers[name];
    if (!entry) throw new Error(`MCP server "${name}" is not in the registry. Run \`rig mcp import\` or check \`rig mcp list\`.`);
    entry.enabled = false;
    entry.disabledAt = now.toISOString();
    this.write(registry);
    return this.sync();
  }

  /**
   * Registry is the source of truth. Enabled entries are written to claude.json;
   * disabled registry entries are removed. Servers only in claude.json are left alone.
   * Idempotent: the file is untouched when nothing would change.
   */
  sync(): SyncResult {
    const registry = this.read();
    const current = this.readClaudeMcpServers();
    const next = { ...current };
    const result: SyncResult = { written: [], removed: [] };
    for (const [name, entry] of Object.entries(registry.servers)) {
      if (entry.enabled) {
        if (JSON.stringify(current[name]) !== JSON.stringify(entry.config)) result.written.push(name);
        next[name] = entry.config;
      } else if (name in next) {
        delete next[name];
        result.removed.push(name);
      }
    }
    if (result.written.length > 0 || result.removed.length > 0) this.writeClaudeMcpServers(next);
    return result;
  }
}
