// RIG-189 regression: daemon start readiness deadline configurable via config key.
// Guards against regression to the original hard-coded 20s and verifies the new
// daemon.startup_deadline_seconds key resolves from default, file, and env sources.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ConfigStore, VALID_KEYS } from "../src/config-store.js";

let dir: string;
let configPath: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daemon-startup-deadline-"));
  configPath = join(dir, "config.json");
  savedEnv = process.env["OPENRIG_STARTUP_DEADLINE_SECONDS"];
  delete process.env["OPENRIG_STARTUP_DEADLINE_SECONDS"];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env["OPENRIG_STARTUP_DEADLINE_SECONDS"];
  else process.env["OPENRIG_STARTUP_DEADLINE_SECONDS"] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

describe("daemon.startup_deadline_seconds config key", () => {
  it("is registered in VALID_KEYS", () => {
    expect(VALID_KEYS).toContain("daemon.startup_deadline_seconds");
  });

  it("defaults to 90 seconds (not the original 20s)", () => {
    const store = new ConfigStore(configPath);
    const resolved = store.resolveWithSource("daemon.startup_deadline_seconds");
    expect(resolved.value).toBe(90);
    expect(resolved.source).toBe("default");
  });

  it("reads value from config file", () => {
    writeFileSync(configPath, JSON.stringify({ daemon: { startupDeadlineSeconds: 120 } }));
    const store = new ConfigStore(configPath);
    const resolved = store.resolveWithSource("daemon.startup_deadline_seconds");
    expect(resolved.value).toBe(120);
    expect(resolved.source).toBe("file");
  });

  it("reads value from environment variable OPENRIG_STARTUP_DEADLINE_SECONDS", () => {
    process.env["OPENRIG_STARTUP_DEADLINE_SECONDS"] = "180";
    const store = new ConfigStore(configPath);
    const resolved = store.resolveWithSource("daemon.startup_deadline_seconds");
    expect(resolved.value).toBe(180);
    expect(resolved.source).toBe("env");
  });

  it("env var overrides file value", () => {
    writeFileSync(configPath, JSON.stringify({ daemon: { startupDeadlineSeconds: 120 } }));
    process.env["OPENRIG_STARTUP_DEADLINE_SECONDS"] = "300";
    const store = new ConfigStore(configPath);
    const resolved = store.resolveWithSource("daemon.startup_deadline_seconds");
    expect(resolved.value).toBe(300);
    expect(resolved.source).toBe("env");
  });

  it("rejects values below minimum (10s)", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("daemon.startup_deadline_seconds", "5")).toThrow(/\[10, 3600\]/);
  });

  it("rejects values above maximum (3600s)", () => {
    const store = new ConfigStore(configPath);
    expect(() => store.set("daemon.startup_deadline_seconds", "7200")).toThrow(/\[10, 3600\]/);
  });
});
