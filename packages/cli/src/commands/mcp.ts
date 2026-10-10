import { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, type LifecycleDeps , daemonStatusGuard} from "../daemon-lifecycle.js";
import { createMcpServer } from "../mcp-server.js";
import { McpRegistry, redactConfig, transportOf } from "../domain/mcp-registry.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

/**
 * `rig mcp` — `serve` starts the MCP server wrapping the daemon API;
 * list/enable/disable/import/sync/show manage the MCP server registry.
 * @param depsOverride - injectable deps for testing
 * @returns Commander command
 */
export function mcpCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("mcp").description("MCP server for agent integration");
  const getDepsF = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };

  cmd
    .command("serve")
    .description("Start MCP server (stdio transport)")
    .option("--port <port>", "Daemon port override")
    .action(async (opts: { port?: string }) => {
      const deps = getDepsF();

      let daemonUrl: string;
      if (opts.port) {
        const daemonPort = parseInt(opts.port, 10);
        if (isNaN(daemonPort)) {
          console.error("Invalid port number");
          process.exitCode = 1;
          return;
        }
        daemonUrl = `http://127.0.0.1:${daemonPort}`;
      } else {
        const status = await getDaemonStatus(deps.lifecycleDeps);
        if (!daemonStatusGuard(status)) return;
        daemonUrl = getDaemonUrl(status);
      }

      const client = deps.clientFactory(daemonUrl);
      const server = createMcpServer(client);
      const transport = new StdioServerTransport();
      let finish!: () => void;
      const closed = new Promise<void>((resolve) => { finish = resolve; });
      server.server.onclose = finish;
      process.stdin.once("end", finish);
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      try {
        // EOF is a normal stdio disconnect, not an unresolved top-level await.
        await server.connect(transport);
        if (process.stdin.readableEnded) finish();
        await closed;
      } finally {
        process.stdin.removeListener("end", finish);
        process.removeListener("SIGINT", finish);
        process.removeListener("SIGTERM", finish);
        await server.close();
      }
    });

  const registryAction = (fn: (reg: McpRegistry) => void) => () => {
    try { fn(new McpRegistry()); }
    catch (err) { console.error((err as Error).message); process.exitCode = 1; }
  };
  const syncSummary = (r: { written: string[]; removed: string[] }) =>
    `claude.json: ${r.written.length} written, ${r.removed.length} removed`;

  cmd
    .command("list")
    .description("List registered MCP servers and their enabled state")
    .action(registryAction((reg) => {
      const rows = reg.list();
      if (rows.length === 0) { console.log("No servers registered. Run `rig mcp import`."); return; }
      const w = Math.max(4, ...rows.map((r) => r.name.length));
      console.log(`${"NAME".padEnd(w)}  ${"TRANSPORT".padEnd(9)}  ${"ENABLED".padEnd(7)}  NOTE`);
      for (const r of rows) console.log(`${r.name.padEnd(w)}  ${transportOf(r.config).padEnd(9)}  ${String(r.enabled).padEnd(7)}  ${r.note ?? ""}`);
    }));

  cmd
    .command("enable <name>")
    .description("Enable a registered MCP server and sync to ~/.claude.json")
    .action((name: string) => registryAction((reg) => console.log(`Enabled ${name}. ${syncSummary(reg.enable(name))}`))());

  cmd
    .command("disable <name>")
    .description("Disable a registered MCP server and remove it from ~/.claude.json (config kept in registry)")
    .action((name: string) => registryAction((reg) => console.log(`Disabled ${name}. ${syncSummary(reg.disable(name))}`))());

  cmd
    .command("import")
    .description("Add servers from ~/.claude.json mcpServers to the registry (skips existing)")
    .action(registryAction((reg) => {
      const r = reg.import();
      console.log(`Imported ${r.added.length}, skipped ${r.skipped.length} already registered.`);
    }));

  cmd
    .command("sync")
    .description("Write the registry's enabled servers to ~/.claude.json and remove disabled ones")
    .action(registryAction((reg) => console.log(syncSummary(reg.sync()))));

  cmd
    .command("show <name>")
    .description("Show one server's config (header and env values masked)")
    .option("--reveal", "Show actual header and env values")
    .action((name: string, opts: { reveal?: boolean }) => registryAction((reg) => {
      const entry = reg.get(name);
      console.log(JSON.stringify({ ...entry, config: opts.reveal ? entry.config : redactConfig(entry.config) }, null, 2));
    })());

  return cmd;
}
