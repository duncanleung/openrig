// RIG-130 — registry drift guard. A merge once dropped 16 migrations from
// ALL_MIGRATIONS while their files stayed on disk, so the fleet-store tables
// were never created. Every migration file must be registered exactly once.
import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import Database from "better-sqlite3";
import { ALL_MIGRATIONS, type Migration } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "db", "migrations");
const FILES = readdirSync(DIR).filter((f) => f.endsWith(".ts")).sort();

async function exportedMigrations(file: string): Promise<Migration[]> {
  const mod = (await import(resolve(DIR, file))) as Record<string, unknown>;
  return Object.values(mod).filter(
    (v): v is Migration =>
      !!v && typeof v === "object" && typeof (v as Migration).name === "string" && typeof (v as Migration).sql === "string",
  );
}

describe("ALL_MIGRATIONS registry parity", () => {
  it("registers every migration file on disk", async () => {
    const registered = new Set(ALL_MIGRATIONS);
    const missing: string[] = [];
    for (const file of FILES) {
      const exported = await exportedMigrations(file);
      if (exported.length === 0) missing.push(`${file} (no Migration export)`);
      for (const m of exported) if (!registered.has(m)) missing.push(`${file} -> ${m.name}`);
    }
    expect(missing).toEqual([]);
  });

  it("registers each migration name exactly once", () => {
    const names = ALL_MIGRATIONS.map((m) => m.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
    expect(names.length).toBe(FILES.length);
  });

  it("creates the fleet-store tables on a fresh database and is idempotent", () => {
    const db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    migrate(db, ALL_MIGRATIONS);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name),
    );
    for (const t of ["session_digests", "review_runs", "review_findings", "daily_token_snapshots"]) {
      expect(tables.has(t)).toBe(true);
    }
    const cols = (db.prepare("PRAGMA table_info(session_digests)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("stall_patterns");
    db.close();
  });
});
