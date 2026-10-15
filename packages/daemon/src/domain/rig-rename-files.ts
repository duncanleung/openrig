// RIG-61: the file half of `rig rename`. Plans every file edit and rename under OPENRIG_HOME, runs
// them through a journal so a failure can be undone in reverse, and scans the result for residue.
//
// All filesystem access goes through RenameFs so tests can inject a failure at an exact step.

import nodeFs from "node:fs";
import nodePath from "node:path";
import { createHash } from "node:crypto";
import { rewriteJsonValue, rewriteSessionRefsInText } from "./rig-rename-manifest.js";

// ---- filesystem seam ---------------------------------------------------------------------

export interface DirEntry { name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }

export interface RenameFs {
  exists(path: string): boolean;
  readText(path: string): string;
  /** Atomic from the reader's point of view: write a temp file next to `path`, then rename over it. */
  writeText(path: string, content: string, mode?: number): void;
  rename(from: string, to: string): void;
  copy(from: string, to: string): void;
  mkdirp(path: string): void;
  remove(path: string): void;
  readdir(path: string): DirEntry[];
  stat(path: string): { size: number; mode: number; isDirectory: boolean; isSymlink: boolean } | null;
}

export const nodeRenameFs: RenameFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf-8"),
  writeText: (p, content, mode) => {
    const tmp = `${p}.rig-rename-${process.pid}.tmp`;
    nodeFs.writeFileSync(tmp, content, { encoding: "utf-8", mode });
    if (mode !== undefined) nodeFs.chmodSync(tmp, mode);
    nodeFs.renameSync(tmp, p);
  },
  rename: (a, b) => nodeFs.renameSync(a, b),
  copy: (a, b) => nodeFs.copyFileSync(a, b),
  mkdirp: (p) => { nodeFs.mkdirSync(p, { recursive: true }); },
  remove: (p) => { nodeFs.rmSync(p, { recursive: true, force: true }); },
  readdir: (p) => {
    try {
      return nodeFs.readdirSync(p, { withFileTypes: true }).map((e) => ({
        name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile(), isSymlink: e.isSymbolicLink(),
      }));
    } catch { return []; }
  },
  stat: (p) => {
    try {
      const s = nodeFs.lstatSync(p);
      return { size: s.size, mode: s.mode & 0o7777, isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink() };
    } catch { return null; }
  },
};

// ---- plan ----------------------------------------------------------------------------------

export interface PlannedOp {
  surface: string;
  kind: "write" | "rename";
  /** write: the file to rewrite. */
  path?: string;
  /** write: the new content. Held in memory; never journaled. */
  content?: string;
  from?: string;
  to?: string;
  detail: string;
}

export interface PlanContext {
  /** OPENRIG_HOME. */
  home: string;
  /** Directories scanned for user spec files (rig specs and workflow specs). Built-in specs are not here. */
  specRoots: string[];
  /** Paths the rename must never edit (built-in spec directories shipped with the daemon). */
  protectedRoots: string[];
  /** workflow_specs.source_path of cached rows that reference the old rig. */
  workflowSourcePaths: string[];
  from: string;
  to: string;
}

export interface FilePlan {
  ops: PlannedOp[];
  skipped: Array<{ path: string; reason: string }>;
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([".worktrees", "node_modules", ".git", "dist", "build", ".turbo", ".next"]);
const FILE_TAIL = /^(?:\.(?:json|jsonl|log|md|txt|yaml|yml|lock|pid|tmp|bak|gz|zst|old|\d+))*$/;

/** `seat@old.json` -> `seat@new.json`. The rig must be followed by nothing or by a known file extension. */
export function renamedFileName(name: string, from: string, to: string): string | null {
  const at = name.indexOf("@");
  if (at < 1) return null;
  const rest = name.slice(at + 1);
  if (!rest.startsWith(from)) return null;
  const tail = rest.slice(from.length);
  return FILE_TAIL.test(tail) ? `${name.slice(0, at + 1)}${to}${tail}` : null;
}

const join = nodePath.join;

function isInside(child: string, parent: string): boolean {
  const rel = nodePath.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !nodePath.isAbsolute(rel));
}

/** Pretty-printing is preserved: indent width and a trailing newline carry over. */
function rewriteJsonFileText(text: string, from: string, to: string): { text: string; count: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rewriteSessionRefsInText(text, from, to);
  }
  const { value, count } = rewriteJsonValue(parsed, from, to);
  if (count === 0) return { text, count: 0 };
  const indentMatch = /^\n?([ \t]+)\S/m.exec(text);
  const indent = indentMatch ? indentMatch[1]!.includes("\t") ? "\t" : indentMatch[1]!.length : undefined;
  const body = JSON.stringify(value, null, text.includes("\n") ? (indent ?? 2) : undefined);
  return { text: text.endsWith("\n") ? `${body}\n` : body, count };
}

/** Line edits keep YAML comments and layout: only the matched values change. */
export function rewriteYamlText(
  text: string,
  from: string,
  to: string,
  opts: { rigSpecName: boolean; workflowRigKeys: boolean },
): { text: string; count: number } {
  let count = 0;
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = text;
  if (opts.rigSpecName) {
    out = out.replace(new RegExp(`^(name:[ \\t]*)(["']?)${esc}\\2([ \\t]*(?:#.*)?)$`, "m"), (_m, k: string, q: string, tail: string) => {
      count += 1;
      return `${k}${q}${to}${q}${tail}`;
    });
  }
  if (opts.workflowRigKeys) {
    out = out.replace(new RegExp(`^([ \\t]*(?:target_rig|rig):[ \\t]*)(["']?)${esc}\\2([ \\t]*(?:#.*)?)$`, "gm"), (_m, k: string, q: string, tail: string) => {
      count += 1;
      return `${k}${q}${to}${q}${tail}`;
    });
  }
  const refs = rewriteSessionRefsInText(out, from, to);
  return { text: refs.text, count: count + refs.count };
}

function topLevelName(text: string): string | null {
  const m = /^name:[ \t]*(["']?)([^"'#\r\n]+?)\1[ \t]*(?:#.*)?$/m.exec(text);
  return m ? m[2]!.trim() : null;
}

class Planner {
  readonly ops: PlannedOp[] = [];
  readonly skipped: FilePlan["skipped"] = [];
  private readonly writes = new Set<string>();
  private readonly fileRenames: PlannedOp[] = [];
  private readonly dirRenames: PlannedOp[] = [];

  constructor(private readonly fs: RenameFs, private readonly ctx: PlanContext) {}

  private get from(): string { return this.ctx.from; }
  private get to(): string { return this.ctx.to; }

  private protectedPath(p: string): boolean {
    return this.ctx.protectedRoots.some((root) => isInside(p, root));
  }

  private readable(path: string): string | null {
    const st = this.fs.stat(path);
    if (!st || st.isDirectory) return null;
    if (st.isSymlink) {
      this.skipped.push({ path, reason: "symbolic link; not rewritten" });
      return null;
    }
    if (st.size > MAX_TEXT_BYTES) {
      this.skipped.push({ path, reason: `larger than ${MAX_TEXT_BYTES} bytes; not rewritten` });
      return null;
    }
    try { return this.fs.readText(path); } catch { return null; }
  }

  addWrite(surface: string, path: string, content: string, count: number): void {
    if (this.writes.has(path)) return;
    this.writes.add(path);
    this.ops.push({ surface, kind: "write", path, content, detail: `rewrite ${count} reference(s)` });
  }

  addRename(surface: string, from: string, to: string, isDir: boolean): void {
    const op: PlannedOp = { surface, kind: "rename", from, to, detail: isDir ? "rename directory" : "rename file" };
    (isDir ? this.dirRenames : this.fileRenames).push(op);
  }

  /** Rewrite the content of one file if it changes. */
  private rewriteFile(surface: string, path: string, mode: "json" | "text"): void {
    if (this.protectedPath(path)) return;
    const text = this.readable(path);
    if (text === null) return;
    const next = mode === "json" ? rewriteJsonFileText(text, this.from, this.to) : rewriteSessionRefsInText(text, this.from, this.to);
    if (next.count > 0 && next.text !== text) this.addWrite(surface, path, next.text, next.count);
  }

  /** Files directly in `dir` (or `depth` levels down): rename `seat@old.ext`, rewrite content when `content` is set. */
  scanFiles(surface: string, dir: string, opts: { depth: number; content: "json" | "text" | null; names: boolean; exts?: RegExp }): void {
    const walk = (current: string, level: number): void => {
      for (const entry of this.fs.readdir(current)) {
        if (entry.isSymlink) continue;
        const full = join(current, entry.name);
        if (entry.isDirectory) {
          if (level < opts.depth && !SKIP_DIRS.has(entry.name)) walk(full, level + 1);
          continue;
        }
        if (!entry.isFile) continue;
        if (opts.content !== null && (opts.exts ? opts.exts.test(entry.name) : true)) this.rewriteFile(surface, full, opts.content);
        if (opts.names) {
          const renamed = renamedFileName(entry.name, this.from, this.to);
          if (renamed) this.addRename(surface, full, join(current, renamed), false);
        }
      }
    };
    walk(dir, 0);
  }

  /** `parent/<old>` -> `parent/<new>`. Returns whether the directory exists. */
  renameChildDir(surface: string, parent: string): boolean {
    const oldDir = join(parent, this.from);
    const st = this.fs.stat(oldDir);
    if (!st || !st.isDirectory) return false;
    this.addRename(surface, oldDir, join(parent, this.to), true);
    return true;
  }

  specFiles(): void {
    const seenDirRenames = new Set<string>();
    const consider = (surface: string, file: string, root: string | null): void => {
      if (this.protectedPath(file)) return;
      const text = this.readable(file);
      if (text === null) return;
      const rigSpec = topLevelName(text) === this.from && /^(pods|nodes):/m.test(text);
      const workflow = /^workflow:/m.test(text);
      const next = rewriteYamlText(text, this.from, this.to, { rigSpecName: rigSpec, workflowRigKeys: workflow });
      if (next.count > 0 && next.text !== text) this.addWrite(surface, file, next.text, next.count);
      if (!rigSpec || root === null) return;
      const base = nodePath.basename(file);
      const stem = base.replace(/\.(ya?ml)$/i, "");
      if (stem === this.from) {
        this.addRename(surface, file, join(nodePath.dirname(file), `${this.to}${base.slice(stem.length)}`), false);
        return;
      }
      const parent = nodePath.dirname(file);
      if (nodePath.basename(parent) === this.from && parent !== root && !seenDirRenames.has(parent)) {
        seenDirRenames.add(parent);
        this.addRename(surface, parent, join(nodePath.dirname(parent), this.to), true);
      }
    };

    const covered = new Set<string>();
    for (const root of this.ctx.specRoots) {
      const stack = [root];
      while (stack.length > 0) {
        const dir = stack.pop()!;
        for (const entry of this.fs.readdir(dir)) {
          if (entry.isSymlink) continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory) {
            if (!SKIP_DIRS.has(entry.name)) stack.push(full);
          } else if (entry.isFile && /\.ya?ml$/i.test(entry.name)) {
            covered.add(full);
            consider("specs", full, root);
          }
        }
      }
    }
    for (const file of this.ctx.workflowSourcePaths) {
      if (covered.has(file) || !this.fs.exists(file)) continue;
      if (this.protectedPath(file)) {
        this.skipped.push({ path: file, reason: "built-in spec; not edited (the cached row is still updated)" });
        continue;
      }
      consider("workflow-specs", file, null);
    }
  }

  /** Ops in execution order: content writes, then file renames, then directory renames (deepest first). */
  finish(): FilePlan {
    const dirs = [...this.dirRenames].sort((a, b) => (b.from?.length ?? 0) - (a.from?.length ?? 0));
    return { ops: [...this.ops, ...this.fileRenames, ...dirs], skipped: this.skipped };
  }
}

/** Where `seat@rig`-named state lives under OPENRIG_HOME. Shared by the plan and the collision scan. */
export function buildFilePlan(fs: RenameFs, ctx: PlanContext): FilePlan {
  const p = new Planner(fs, ctx);
  const h = ctx.home;

  p.specFiles();

  // UUID-named or seat@rig-named sidecars: the content holds the session names, so inspect content.
  for (const dir of [join(h, "state", "provider-usage"), join(h, "state", "context-usage"), join(h, "provider-usage"), join(h, "context")]) {
    p.scanFiles(`state:${nodePath.relative(h, dir)}`, dir, { depth: 0, content: "json", names: true, exts: /\.json$/ });
  }
  p.scanFiles("compaction/restore-pending", join(h, "compaction", "restore-pending"), { depth: 0, content: "json", names: true, exts: /\.json$/ });

  // Rig-scoped trees. Directory is renamed last; its files are renamed while it still has the old path.
  p.scanFiles("topology", join(h, "topology", "rigs", ctx.from), { depth: 6, content: "text", names: true, exts: /\.(md|txt|ya?ml|json)$/i });
  p.renameChildDir("topology", join(h, "topology", "rigs"));
  p.scanFiles("refocus", join(h, "refocus", ctx.from), { depth: 4, content: "text", names: true, exts: /\.(md|txt|ya?ml|json)$/i });
  p.scanFiles("refocus", join(h, "refocus"), { depth: 0, content: "text", names: true, exts: /\.(md|txt|ya?ml|json)$/i });
  p.renameChildDir("refocus", join(h, "refocus"));
  p.scanFiles("prompts", join(h, "prompts"), { depth: 4, content: "text", names: true, exts: /\.(md|txt|ya?ml|json)$/i });

  // Transcripts and logs: renamed in place. Their content is history and is never rewritten.
  p.scanFiles("transcripts", join(h, "transcripts", ctx.from), { depth: 2, content: null, names: true });
  p.scanFiles("transcripts", join(h, "transcripts"), { depth: 0, content: null, names: true });
  p.renameChildDir("transcripts", join(h, "transcripts"));
  p.scanFiles("logs", join(h, "logs"), { depth: 3, content: null, names: true });

  return p.finish();
}

/** Existing files and directories that already use `name`. A rename to that name is refused. */
export function findNameArtifacts(fs: RenameFs, ctx: Omit<PlanContext, "from" | "to"> & { name: string }): string[] {
  const hits: string[] = [];
  const h = ctx.home;
  const probe = "\u0000none";
  for (const parent of [join(h, "topology", "rigs"), join(h, "refocus"), join(h, "transcripts")]) {
    const dir = join(parent, ctx.name);
    if (fs.exists(dir)) hits.push(dir);
  }
  // Spec files: a rig spec named `name`, a file or directory called `name`.
  for (const root of ctx.specRoots) {
    const stack = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      for (const entry of fs.readdir(dir)) {
        if (entry.isSymlink) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory) {
          if (entry.name === ctx.name && full !== root) hits.push(full);
          if (!SKIP_DIRS.has(entry.name)) stack.push(full);
        } else if (entry.isFile && /\.ya?ml$/i.test(entry.name)) {
          if (entry.name.replace(/\.ya?ml$/i, "") === ctx.name) { hits.push(full); continue; }
          const st = fs.stat(full);
          if (!st || st.size > MAX_TEXT_BYTES) continue;
          try {
            const text = fs.readText(full);
            if (topLevelName(text) === ctx.name && /^(pods|nodes):/m.test(text)) hits.push(full);
          } catch { /* unreadable: ignore */ }
        }
      }
    }
  }
  // State files already named `seat@name.ext`, found by planning a rename away from `name`.
  const plan = buildFilePlan(fs, { ...ctx, workflowSourcePaths: [], from: ctx.name, to: probe });
  for (const op of plan.ops) if (op.kind === "rename" && op.from) hits.push(op.from);
  return [...new Set(hits)];
}

// ---- journal ---------------------------------------------------------------------------------

export type OpState = "pending" | "started" | "done" | "undone";
export type JournalPhase =
  | "planned"
  | "db-committed"
  | "files-applied"
  | "rolling-back"
  | "rollback-failed"
  | "compensation-failed";

export interface JournalOp {
  index: number;
  surface: string;
  kind: "write" | "rename";
  path?: string;
  from?: string;
  to?: string;
  /** write: copy of the original file, restored on rollback. */
  backup?: string;
  /** write: sha256 of the content that was written, for the verify step. */
  sha256?: string;
  state: OpState;
}

export interface Journal {
  version: 1;
  id: string;
  oldName: string;
  newName: string;
  startedAt: string;
  phase: JournalPhase;
  error?: string;
  ops: JournalOp[];
}

export function journalPaths(home: string): { file: string; backups: string } {
  return { file: join(home, "run", "rig-rename-journal.json"), backups: join(home, "run", "rig-rename-journal.backup") };
}

export function readJournal(fs: RenameFs, home: string): Journal | null {
  const { file } = journalPaths(home);
  if (!fs.exists(file)) return null;
  try {
    return JSON.parse(fs.readText(file)) as Journal;
  } catch {
    // An unreadable journal still blocks a new rename: its presence is the signal.
    return { version: 1, id: "unreadable", oldName: "?", newName: "?", startedAt: "?", phase: "rollback-failed", error: `journal at ${file} is not valid JSON`, ops: [] };
  }
}

export function writeJournal(fs: RenameFs, home: string, journal: Journal): void {
  const { file } = journalPaths(home);
  fs.mkdirp(nodePath.dirname(file));
  fs.writeText(file, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

export function removeJournal(fs: RenameFs, home: string): void {
  const { file, backups } = journalPaths(home);
  fs.remove(file);
  fs.remove(backups);
}

export function newJournal(home: string, oldName: string, newName: string, plan: FilePlan, id: string, now: string): Journal {
  const { backups } = journalPaths(home);
  const ops: JournalOp[] = plan.ops.map((op, index) => ({
    index,
    surface: op.surface,
    kind: op.kind,
    ...(op.kind === "write"
      ? { path: op.path, backup: join(backups, String(index)), sha256: sha(op.content ?? "") }
      : { from: op.from, to: op.to }),
    state: "pending" as const,
  }));
  return { version: 1, id, oldName, newName, startedAt: now, phase: "planned", ops };
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Applies the planned ops in order. The journal is persisted before and after every op. On the first
 * error the function throws and leaves the journal as it stands: states `started` and `done` are
 * what rollbackOps undoes.
 */
export function applyOps(fs: RenameFs, home: string, journal: Journal, plan: FilePlan): void {
  for (const jop of journal.ops) {
    const op = plan.ops[jop.index]!;
    if (jop.kind === "write") {
      const mode = fs.stat(jop.path!)?.mode;
      fs.mkdirp(nodePath.dirname(jop.backup!));
      fs.copy(jop.path!, jop.backup!);
      jop.state = "started";
      writeJournal(fs, home, journal);
      fs.writeText(jop.path!, op.content ?? "", mode);
    } else {
      if (fs.exists(jop.to!)) throw new Error(`refusing to overwrite existing ${jop.to}`);
      jop.state = "started";
      writeJournal(fs, home, journal);
      fs.rename(jop.from!, jop.to!);
    }
    jop.state = "done";
    writeJournal(fs, home, journal);
  }
}

export interface RollbackFailure { index: number; op: string; error: string }

/** Undoes started/done ops in reverse. Each step is idempotent so a repeated recovery is safe. */
export function rollbackOps(fs: RenameFs, home: string, journal: Journal): RollbackFailure[] {
  const failures: RollbackFailure[] = [];
  for (const jop of [...journal.ops].reverse()) {
    if (jop.state === "pending" || jop.state === "undone") continue;
    try {
      if (jop.kind === "rename") {
        if (fs.exists(jop.to!) && !fs.exists(jop.from!)) fs.rename(jop.to!, jop.from!);
      } else if (jop.backup && fs.exists(jop.backup)) {
        const mode = fs.stat(jop.path!)?.mode;
        fs.writeText(jop.path!, fs.readText(jop.backup), mode);
      }
      jop.state = "undone";
      writeJournal(fs, home, journal);
    } catch (err) {
      failures.push({ index: jop.index, op: jop.kind === "rename" ? `rename ${jop.to} -> ${jop.from}` : `restore ${jop.path} from ${jop.backup}`, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return failures;
}

/** Checks that every done op left the expected bytes on disk. Returns the problems found. */
export function verifyOps(fs: RenameFs, journal: Journal): string[] {
  const problems: string[] = [];
  for (const jop of journal.ops) {
    if (jop.kind === "rename") {
      // A later op may move the parent directory, so judge the path as it ends up.
      const dest = finalPath(journal, jop.to!, jop.index);
      if (!fs.exists(dest)) problems.push(`missing after rename: ${dest}`);
      if (fs.exists(jop.from!)) problems.push(`still present after rename: ${jop.from}`);
    } else if (jop.path && jop.sha256) {
      const final = finalPath(journal, jop.path, jop.index);
      let actual: string | null = null;
      try { actual = sha(fs.readText(final)); } catch { /* reported below */ }
      if (actual !== jop.sha256) problems.push(`content differs from the plan: ${final}`);
    }
  }
  return problems;
}

/** Where `start` ends up after the rename ops that come after op `afterIndex`. */
function finalPath(journal: Journal, start: string, afterIndex: number): string {
  let current = start;
  for (const jop of journal.ops) {
    if (jop.index <= afterIndex || jop.kind !== "rename" || !jop.from || !jop.to) continue;
    if (current === jop.from) current = jop.to;
    else if (current.startsWith(`${jop.from}${nodePath.sep}`)) current = jop.to + current.slice(jop.from.length);
  }
  return current;
}

// ---- residue scan -------------------------------------------------------------------------------

export interface ResidueHit { path: string; where: "name" | "content"; count: number }

/**
 * Looks for the old name in what is left under OPENRIG_HOME. Content is scanned in the state and
 * config trees; transcripts and logs are checked by file name only because their text is history.
 * Hits are reported, never rewritten.
 */
export function scanResidue(fs: RenameFs, home: string, name: string, limit = 200): ResidueHit[] {
  const hits: ResidueHit[] = [];
  const contentTrees = ["state", "compaction", "topology", "refocus", "prompts", "specs", "provider-usage", "context"];
  const nameTrees = ["transcripts", "logs"];
  const walk = (dir: string, content: boolean, depth: number): void => {
    if (hits.length >= limit || depth > 8) return;
    for (const entry of fs.readdir(dir)) {
      if (entry.isSymlink) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        if (entry.name === name) hits.push({ path: full, where: "name", count: 1 });
        if (!SKIP_DIRS.has(entry.name)) walk(full, content, depth + 1);
      } else if (entry.isFile) {
        if (renamedFileName(entry.name, name, "x") !== null) hits.push({ path: full, where: "name", count: 1 });
        if (content) {
          const st = fs.stat(full);
          if (!st || st.size > MAX_TEXT_BYTES) continue;
          try {
            const { count } = rewriteSessionRefsInText(fs.readText(full), name, "x");
            if (count > 0) hits.push({ path: full, where: "content", count });
          } catch { /* binary or unreadable: ignore */ }
        }
      }
    }
  };
  for (const t of contentTrees) walk(join(home, t), true, 0);
  for (const t of nameTrees) walk(join(home, t), false, 0);
  return hits.slice(0, limit);
}
