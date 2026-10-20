// RIG-113: createDaemon builds four groups through init functions (package + bootstrap, discovery,
// context-pack library, transcript config). Pins that each group's services still reach AppDeps.
// A dropped return value passes the type-blind test runner but leaves the member undefined here.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon } from "../src/startup.js";
import type { AppDeps } from "../src/server.js";
import type { CmuxTransportFactory } from "../src/terminal/cmux-transport.js";
import type { ExecFn } from "../src/domain/tmux-adapter.js";
import type Database from "better-sqlite3";

let db: Database.Database;
let deps: AppDeps;
let scratch: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rig113-groups-"));
  for (const k of ["OPENRIG_HOME", "OPENRIG_DB", "OPENRIG_URL", "OPENRIG_PORT", "OPENRIG_NO_KERNEL"]) savedEnv[k] = process.env[k];
  process.env.OPENRIG_HOME = path.join(scratch, "home");
  process.env.OPENRIG_DB = path.join(scratch, "groups.sqlite");
  delete process.env.OPENRIG_URL;
  delete process.env.OPENRIG_PORT;
  process.env.OPENRIG_NO_KERNEL = "1";
  const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error("no socket"), { code: "ENOENT" }); };
  const tmuxExec: ExecFn = async () => "";
  const result = await createDaemon({ cmuxFactory, tmuxExec, dbPath: process.env.OPENRIG_DB! });
  db = result.db;
  deps = result.deps;
}, 60000);

afterAll(() => {
  db?.close();
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe("RIG-113 — services built by the extracted init groups reach AppDeps", () => {
  const MEMBERS: Array<keyof AppDeps> = [
    // package + bootstrap group
    "packageRepo", "installRepo", "installEngine", "installVerifier", "bootstrapRepo",
    // discovery group
    "discoveryCoordinator",
    // context-pack library group
    "contextPackLibrary",
    // transcript config group
    "transcriptStore",
  ];
  for (const member of MEMBERS) {
    it(`deps.${String(member)} is composed`, () => {
      expect(deps[member], `AppDeps.${String(member)} must come from createDaemon`).toBeDefined();
    });
  }
});
