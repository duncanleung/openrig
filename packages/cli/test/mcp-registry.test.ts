import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpRegistry, redactConfig, resolveMcpPaths, transportOf } from "../src/domain/mcp-registry.js";

let dir: string;
let reg: McpRegistry;
const http = { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer secret" } };
const stdio = { command: "npx", args: ["-y", "pkg"], env: { API_KEY: "secret" } };

const claude = () => JSON.parse(fs.readFileSync(join(dir, ".claude.json"), "utf-8"));
const seedClaude = (doc: object) => fs.writeFileSync(join(dir, ".claude.json"), JSON.stringify(doc));

beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), "mcp-registry-"));
  reg = new McpRegistry({ registryPath: join(dir, "openrig", "mcp-registry.json"), claudeJsonPath: join(dir, ".claude.json") });
  seedClaude({ theme: "dark", projects: { a: 1 }, mcpServers: { context7: http, local: stdio } });
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("mcp registry", () => {
  it("import adds servers as enabled and is safe to repeat", () => {
    expect(reg.import()).toEqual({ added: ["context7", "local"], skipped: [] });
    expect(reg.import()).toEqual({ added: [], skipped: ["context7", "local"] });
    expect(reg.read().version).toBe(1);
    expect(reg.get("context7")).toEqual({ enabled: true, config: http });
  });

  it("list reports transport and enabled state", () => {
    reg.import();
    reg.disable("local");
    const rows = reg.list();
    expect(rows.map((r) => [r.name, transportOf(r.config), r.enabled])).toEqual([["context7", "http", true], ["local", "stdio", false]]);
  });

  it("disable removes from claude.json, keeps config, and preserves other keys", () => {
    reg.import();
    reg.disable("context7", new Date("2026-10-10T00:00:00Z"));
    expect(claude().mcpServers).toEqual({ local: stdio });
    expect(claude().theme).toBe("dark");
    expect(claude().projects).toEqual({ a: 1 });
    expect(reg.get("context7")).toEqual({ enabled: false, config: http, disabledAt: "2026-10-10T00:00:00.000Z" });
  });

  it("enable restores the entry and clears disabledAt", () => {
    reg.import();
    reg.disable("context7");
    reg.enable("context7");
    expect(claude().mcpServers.context7).toEqual(http);
    expect(reg.get("context7").disabledAt).toBeUndefined();
  });

  it("enable and disable fail for unknown names", () => {
    expect(() => reg.enable("nope")).toThrow(/not in the registry/);
    expect(() => reg.disable("nope")).toThrow(/not in the registry/);
    expect(() => reg.get("nope")).toThrow(/not in the registry/);
  });

  it("sync is idempotent and registry-driven", () => {
    reg.import();
    reg.disable("local");
    fs.writeFileSync(join(dir, ".claude.json"), JSON.stringify({ mcpServers: { local: stdio, context7: { url: "stale" } } }));
    expect(reg.sync()).toEqual({ written: ["context7"], removed: ["local"] });
    const after = fs.readFileSync(join(dir, ".claude.json"), "utf-8");
    expect(reg.sync()).toEqual({ written: [], removed: [] });
    expect(fs.readFileSync(join(dir, ".claude.json"), "utf-8")).toBe(after);
    expect(claude().mcpServers).toEqual({ context7: http });
  });

  it("redacts header and env values but keeps key names", () => {
    expect(redactConfig(http)).toEqual({ ...http, headers: { Authorization: "***" } });
    expect(redactConfig(stdio)).toEqual({ ...stdio, env: { API_KEY: "***" } });
    expect(http.headers.Authorization).toBe("Bearer secret");
  });

  it("resolves paths from env", () => {
    expect(resolveMcpPaths({ OPENRIG_HOME: "/o", CLAUDE_CONFIG_DIR: "/c" })).toEqual({ registryPath: "/o/mcp-registry.json", claudeJsonPath: "/c/.claude.json" });
  });
});
