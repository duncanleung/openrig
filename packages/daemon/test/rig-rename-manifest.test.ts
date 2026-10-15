import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import {
  RIG_RENAME_EXCLUSIONS,
  RIG_RENAME_GUARD_PATTERN,
  RIG_RENAME_MANIFEST,
  rewriteJsonText,
  rewriteJsonValue,
  rewriteSessionRef,
  rewriteSessionRefsInText,
  validateNewRigName,
  type ManifestExclusion,
} from "../src/domain/rig-rename-manifest.js";

// RIG-61 — the manifest is checked against the REAL migrations. A migration that adds a column
// shaped like a rig or session name fails this file until the column is added to the manifest or
// to the justified exclusion list.

interface Col { table: string; column: string; type: string }

function migratedColumns(): Col[] {
  const db = createDb(":memory:");
  migrate(db, ALL_MIGRATIONS);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const cols: Col[] = [];
  for (const t of tables) {
    for (const c of db.prepare(`PRAGMA table_info("${t.name}")`).all() as Array<{ name: string; type: string }>) {
      cols.push({ table: t.name, column: c.name, type: c.type });
    }
  }
  db.close();
  return cols;
}

const isNumeric = (type: string): boolean => /INT|REAL|NUM|FLOA|DOUB|BLOB/i.test(type);
const excluded = (c: Col, ex: readonly ManifestExclusion[]): ManifestExclusion | undefined =>
  ex.find((e) => (e.table === undefined || e.table === c.table)
    && (typeof e.column === "string" ? e.column === c.column : e.column.test(c.column)));

describe("rig-rename manifest vs the migrated schema (RIG-61)", () => {
  const columns = migratedColumns();

  it("every manifest entry names a real text column", () => {
    for (const m of RIG_RENAME_MANIFEST) {
      const col = columns.find((c) => c.table === m.table && c.column === m.column);
      expect(col, `${m.table}.${m.column} is in the manifest but not in the migrated schema`).toBeDefined();
      expect(isNumeric(col!.type), `${m.table}.${m.column} must be a text column (is ${col!.type})`).toBe(false);
    }
  });

  it("has no duplicate manifest entries", () => {
    const keys = RIG_RENAME_MANIFEST.map((m) => `${m.table}.${m.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("flags every rig/session-shaped text column that is neither in the manifest nor excluded", () => {
    const inManifest = new Set(RIG_RENAME_MANIFEST.map((m) => `${m.table}.${m.column}`));
    const unclassified = columns
      .filter((c) => !isNumeric(c.type) && RIG_RENAME_GUARD_PATTERN.test(c.column))
      .filter((c) => !inManifest.has(`${c.table}.${c.column}`) && !excluded(c, RIG_RENAME_EXCLUSIONS))
      .map((c) => `${c.table}.${c.column}`);
    expect(
      unclassified,
      "Add each column to RIG_RENAME_MANIFEST (it holds a rig or session name) or to RIG_RENAME_EXCLUSIONS with a reason (rig-rename-manifest.ts)",
    ).toEqual([]);
  });

  it("a manifest column is never also excluded", () => {
    for (const m of RIG_RENAME_MANIFEST) {
      expect(excluded({ table: m.table, column: m.column, type: "TEXT" }, RIG_RENAME_EXCLUSIONS),
        `${m.table}.${m.column} is both in the manifest and excluded`).toBeUndefined();
    }
  });

  it("every exclusion matches at least one real column (no stale entries)", () => {
    for (const e of RIG_RENAME_EXCLUSIONS) {
      const hit = columns.some((c) => excluded(c, [e]) !== undefined);
      expect(hit, `exclusion ${String(e.table ?? "*")}.${String(e.column)} matches no column`).toBe(true);
    }
  });

  it("every exclusion carries a reason", () => {
    for (const e of RIG_RENAME_EXCLUSIONS) expect(e.reason.length).toBeGreaterThan(8);
  });

  it("the guard catches a synthetic new column (the guard itself works)", () => {
    const synthetic: Col = { table: "future_table", column: "owner_session", type: "TEXT" };
    expect(RIG_RENAME_GUARD_PATTERN.test(synthetic.column)).toBe(true);
    expect(excluded(synthetic, RIG_RENAME_EXCLUSIONS)).toBeUndefined();
  });
});

describe("suffix-anchored session rewrite (RIG-61)", () => {
  it("changes only values whose rig segment is exactly the old name", () => {
    expect(rewriteSessionRef("dev-impl@old", "old", "new")).toBe("dev-impl@new");
    expect(rewriteSessionRef("dev-impl@old-2", "old", "new")).toBe("dev-impl@old-2");
    expect(rewriteSessionRef("old@host", "old", "new")).toBe("old@host");
    expect(rewriteSessionRef("a@b@old", "old", "new")).toBe("a@b@old");
    expect(rewriteSessionRef("@old", "old", "new")).toBe("@old");
    expect(rewriteSessionRef("dev-impl@older", "old", "new")).toBe("dev-impl@older");
    expect(rewriteSessionRef("plain", "old", "new")).toBe("plain");
  });

  it("rewrites free text only at a rig-name boundary", () => {
    const text = "target: orch@old\nnote: ask orch@old-2 or orch@old.\nmail x@old.example and orch@oldish and orch@old, ok";
    const out = rewriteSessionRefsInText(text, "old", "new");
    expect(out.count).toBe(3);
    expect(out.text).toBe("target: orch@new\nnote: ask orch@old-2 or orch@new.\nmail x@old.example and orch@oldish and orch@new, ok");
  });

  it("treats regex metacharacters in a rig name literally", () => {
    expect(rewriteSessionRefsInText("a@o.d and a@oxd", "o.d", "new").text).toBe("a@new and a@oxd");
  });

  it("rewrites JSON strings, object keys and rig-name keys", () => {
    const { value, count } = rewriteJsonValue(
      { rigName: "old", rig: "old", other: "old", seat: "x@old", keep: "x@old-2", map: { "y@old": 1 }, list: ["z@old", "w@other"] },
      "old", "new");
    expect(value).toEqual({ rigName: "new", rig: "new", other: "old", seat: "x@new", keep: "x@old-2", map: { "y@new": 1 }, list: ["z@new", "w@other"] });
    expect(count).toBe(5);
  });

  it("JSON text that does not parse falls back to the text rewrite", () => {
    expect(rewriteJsonText("not json orch@old", "old", "new").text).toBe("not json orch@new");
    expect(rewriteJsonText('{"a":"b@old"}', "old", "new").text).toBe('{"a":"b@new"}');
    expect(rewriteJsonText('{"a":"b@x"}', "old", "new")).toEqual({ text: '{"a":"b@x"}', count: 0 });
  });
});

describe("new rig name validation (RIG-61)", () => {
  it("accepts names session addresses allow", () => {
    for (const ok of ["prediction-market", "poly_copy", "rig.v2", "a", "A1"]) expect(validateNewRigName(ok)).toBeNull();
  });
  it("rejects empty, long, separators, dot-dot, @ and bad characters", () => {
    for (const bad of ["", "a/b", "a\\b", "..", "a..b", "a@b", "-lead", ".hidden", "a b", "a;b", "x".repeat(65), 5, undefined]) {
      expect(validateNewRigName(bad), String(bad)).not.toBeNull();
    }
  });
});
