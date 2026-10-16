import type { Database } from "better-sqlite3";

// ── Fleet store: upsert writers for the four analytics tables (migrations 096–099). ──

export interface SessionDigestInput {
  rigName: string | null;
  seatSession: string;
  seatName: string | null;
  nodeLogicalId: string | null;
  rigId: string | null;
  nodeId: string | null;
  nativeSessionId: string;
  generationUuid: string | null;
  occupantGeneration: number | null;
  transcriptPath: string;
  transcriptBytes: number | null;
  transcriptModifiedAt: string | null;
  totalTurns: number;
  conversationTurns: number;
  toolCalls: string;
  repeatedReads: string;
  reviewFindings: string;
  handoffEvents: string;
  skillInvocations: string;
  claudeMdLoaded: string;
  errors: string;
  irreversibleActions: string;
  stallPatterns: string;
  compactionBoundaries: string;
  compactionLosses: string;
  tokenUsage: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  escalationCount: number;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  sourceHash: string | null;
  parserVersion: string | null;
}

export interface ReviewRunInput {
  traceId: string;
  prNumber: number | null;
  repo: string | null;
  branch: string | null;
  ticket: string | null;
  headSha: string | null;
  mode: string | null;
  validationMode: string | null;
  modelReview: string | null;
  modelValidator: string | null;
  bundleSizeChars: number | null;
  mustFix: number;
  suggestion: number;
  dismissed: number;
  deferred: number;
  escalated: number;
  crossAgreed: number;
  crossClaudeOnly: number;
  crossCodexOnly: number;
  metricsJson: string;
  rigName: string | null;
  seatName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  logDir: string | null;
  sourceHash: string | null;
  parserVersion: string | null;
}

export interface ReviewFindingInput {
  runTraceId: string;
  findingId: string;
  file: string | null;
  lines: string | null;
  category: string | null;
  hunterKey: string | null;
  stack: string | null;
  score: number | null;
  verdict: string | null;
  hasFixSpec: number | null;
  descriptionPrefix: string | null;
  descriptionHash: string | null;
}

export interface DailyTokenSnapshotInput {
  day: string;
  seatSession: string;
  rigName: string | null;
  seatName: string | null;
  model: string | null;
  inputTokensDelta: number | null;
  outputTokensDelta: number | null;
  totalTokensDelta: number | null;
  samples: number | null;
  resets: number;
  schemaVersion: string | null;
}

export interface FleetStoreStats {
  session_digests: { count: number; last_ingested_at: string | null; total_escalations: number };
  review_runs: { count: number; last_ingested_at: string | null };
  review_findings: { count: number };
  daily_token_snapshots: { count: number; last_snapshot_at: string | null };
}

export interface ListFilter {
  rig?: string;
  seat?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface ReviewListFilter extends ListFilter {
  repo?: string;
  branch?: string;
  pr?: number;
}

export interface SessionDigestRow {
  id: number;
  rig_name: string | null;
  seat_session: string;
  seat_name: string | null;
  native_session_id: string;
  total_turns: number;
  conversation_turns: number;
  transcript_bytes: number | null;
  ingested_at: string;
}

export interface ReviewRunRow {
  id: number;
  trace_id: string;
  pr_number: number | null;
  repo: string | null;
  branch: string | null;
  head_sha: string | null;
  mode: string | null;
  must_fix: number;
  suggestion: number;
  dismissed: number;
  rig_name: string | null;
  seat_name: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
}

export interface ReviewFindingRow {
  id: number;
  run_trace_id: string;
  finding_id: string;
  file: string | null;
  lines: string | null;
  category: string | null;
  hunter_key: string | null;
  stack: string | null;
  score: number | null;
  verdict: string | null;
  description_prefix: string | null;
}

export interface SnapshotRow {
  id: number;
  day: string;
  seat_session: string;
  rig_name: string | null;
  seat_name: string | null;
  model: string | null;
  input_tokens_delta: number | null;
  output_tokens_delta: number | null;
  total_tokens_delta: number | null;
  samples: number | null;
  snapshot_at: string;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 50;
  return Math.min(Math.max(1, Math.floor(raw)), 200);
}

function clampOffset(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

function normalizeUntilDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value + "T23:59:59.999Z";
  return value;
}


// ── Aggregation (RIG-80). Read-only GROUP BY rollups; tokens only, never dollars. ──

/** Label for rows whose rig_name / seat_name / model / week is NULL. Never dropped silently. */
export const UNATTRIBUTED = "(unattributed)";
export const UNDATED = "(undated)";
export const UNKNOWN_MODEL = "(unknown)";

const AGG_DEFAULT_LIMIT = 200;
const AGG_MAX_LIMIT = 500;

export interface AggregateFilter {
  rig?: string;
  seat?: string;
  /** Date-only (YYYY-MM-DD) lower bound. */
  since?: string;
  /** Date-only (YYYY-MM-DD) upper bound, inclusive. */
  until?: string;
  /** Max groups returned (default 200, max 500). */
  limit?: number;
}

export interface AggregateResult<T> {
  rows: T[];
  /** True when more groups existed than `limit`. */
  truncated: boolean;
}

export interface TokensRigDayRow {
  day: string;
  rig_name: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  seats: number;
  samples: number;
}

export interface TokensSeatRow {
  rig_name: string;
  seat_name: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  days: number;
  samples: number;
}

export interface ReviewsSeatWeekRow {
  /** Monday (UTC date) that starts the week, YYYY-MM-DD; "(undated)" when completed_at is missing. */
  week_start: string;
  rig_name: string;
  seat_name: string;
  runs: number;
  must_fix: number;
  suggestion: number;
  dismissed: number;
}

export interface SessionsRigRow {
  rig_name: string;
  sessions: number;
  total_turns: number;
  conversation_turns: number;
  input_tokens: number;
  output_tokens: number;
  escalations: number;
  last_ingested_at: string | null;
}

export interface FleetSummaryRig {
  rig_name: string;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  review_runs: number;
  must_fix: number;
  suggestion: number;
  dismissed: number;
}

export interface FleetSummary {
  totals: {
    rigs: number;
    sessions: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    review_runs: number;
    must_fix: number;
    suggestion: number;
    dismissed: number;
    escalations: number;
  };
  rigs: FleetSummaryRig[];
  top_seats: TokensSeatRow[];
  reviews_by_seat_week: ReviewsSeatWeekRow[];
  stats: FleetStoreStats;
  truncated: boolean;
}

function clampAggLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return AGG_DEFAULT_LIMIT;
  return Math.min(Math.max(1, Math.floor(raw)), AGG_MAX_LIMIT);
}

function label(v: string | null | undefined, fallback: string): string {
  return v === null || v === undefined || v === "" ? fallback : v;
}

export class FleetStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  upsertDigest(d: SessionDigestInput): { id: number; created: boolean } {
    const existing = this.db.prepare(
      "SELECT id FROM session_digests WHERE native_session_id = ?",
    ).get(d.nativeSessionId) as { id: number } | undefined;

    const info = this.db.prepare(`
      INSERT INTO session_digests (
        rig_name, seat_session, seat_name, node_logical_id, rig_id, node_id,
        native_session_id, generation_uuid, occupant_generation,
        transcript_path, transcript_bytes, transcript_modified_at,
        total_turns, conversation_turns,
        tool_calls, repeated_reads, review_findings, handoff_events, skill_invocations,
        claude_md_loaded, errors, irreversible_actions, stall_patterns,
        compaction_boundaries, compaction_losses,
        token_usage, total_input_tokens, total_output_tokens,
        total_cache_creation_tokens, total_cache_read_tokens,
        escalation_count,
        started_at, ended_at, duration_ms,
        source_hash, parser_version
      ) VALUES (
        @rigName, @seatSession, @seatName, @nodeLogicalId, @rigId, @nodeId,
        @nativeSessionId, @generationUuid, @occupantGeneration,
        @transcriptPath, @transcriptBytes, @transcriptModifiedAt,
        @totalTurns, @conversationTurns,
        @toolCalls, @repeatedReads, @reviewFindings, @handoffEvents, @skillInvocations,
        @claudeMdLoaded, @errors, @irreversibleActions, @stallPatterns,
        @compactionBoundaries, @compactionLosses,
        @tokenUsage, @totalInputTokens, @totalOutputTokens,
        @totalCacheCreationTokens, @totalCacheReadTokens,
        @escalationCount,
        @startedAt, @endedAt, @durationMs,
        @sourceHash, @parserVersion
      )
      ON CONFLICT(native_session_id) DO UPDATE SET
        rig_name = excluded.rig_name,
        seat_session = excluded.seat_session,
        seat_name = excluded.seat_name,
        node_logical_id = excluded.node_logical_id,
        rig_id = excluded.rig_id,
        node_id = excluded.node_id,
        generation_uuid = excluded.generation_uuid,
        occupant_generation = excluded.occupant_generation,
        transcript_path = excluded.transcript_path,
        transcript_bytes = excluded.transcript_bytes,
        transcript_modified_at = excluded.transcript_modified_at,
        total_turns = excluded.total_turns,
        conversation_turns = excluded.conversation_turns,
        tool_calls = excluded.tool_calls,
        repeated_reads = excluded.repeated_reads,
        review_findings = excluded.review_findings,
        handoff_events = excluded.handoff_events,
        skill_invocations = excluded.skill_invocations,
        claude_md_loaded = excluded.claude_md_loaded,
        errors = excluded.errors,
        irreversible_actions = excluded.irreversible_actions,
        stall_patterns = excluded.stall_patterns,
        compaction_boundaries = excluded.compaction_boundaries,
        compaction_losses = excluded.compaction_losses,
        token_usage = excluded.token_usage,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        total_cache_creation_tokens = excluded.total_cache_creation_tokens,
        total_cache_read_tokens = excluded.total_cache_read_tokens,
        escalation_count = excluded.escalation_count,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        duration_ms = excluded.duration_ms,
        source_hash = excluded.source_hash,
        parser_version = excluded.parser_version,
        ingested_at = datetime('now')
    `).run(d);

    return { id: existing?.id ?? Number(info.lastInsertRowid), created: !existing };
  }

  upsertReviewRun(run: ReviewRunInput, findings: ReviewFindingInput[] | null): {
    runId: number;
    created: boolean;
    findingsUpserted: number;
    findingsDeleted: number;
  } {
    const result = this.db.transaction(() => {
      const existingRun = this.db.prepare(
        "SELECT id FROM review_runs WHERE trace_id = ?",
      ).get(run.traceId) as { id: number } | undefined;

      const runInfo = this.db.prepare(`
        INSERT INTO review_runs (
          trace_id, pr_number, repo, branch, ticket, head_sha,
          mode, validation_mode, model_review, model_validator,
          bundle_size_chars,
          must_fix, suggestion, dismissed, deferred, escalated,
          cross_agreed, cross_claude_only, cross_codex_only,
          metrics_json,
          rig_name, seat_name,
          started_at, completed_at, duration_seconds,
          log_dir, source_hash, parser_version
        ) VALUES (
          @traceId, @prNumber, @repo, @branch, @ticket, @headSha,
          @mode, @validationMode, @modelReview, @modelValidator,
          @bundleSizeChars,
          @mustFix, @suggestion, @dismissed, @deferred, @escalated,
          @crossAgreed, @crossClaudeOnly, @crossCodexOnly,
          @metricsJson,
          @rigName, @seatName,
          @startedAt, @completedAt, @durationSeconds,
          @logDir, @sourceHash, @parserVersion
        )
        ON CONFLICT(trace_id) DO UPDATE SET
          pr_number = excluded.pr_number,
          repo = excluded.repo,
          branch = excluded.branch,
          ticket = excluded.ticket,
          head_sha = excluded.head_sha,
          mode = excluded.mode,
          validation_mode = excluded.validation_mode,
          model_review = excluded.model_review,
          model_validator = excluded.model_validator,
          bundle_size_chars = excluded.bundle_size_chars,
          must_fix = excluded.must_fix,
          suggestion = excluded.suggestion,
          dismissed = excluded.dismissed,
          deferred = excluded.deferred,
          escalated = excluded.escalated,
          cross_agreed = excluded.cross_agreed,
          cross_claude_only = excluded.cross_claude_only,
          cross_codex_only = excluded.cross_codex_only,
          metrics_json = excluded.metrics_json,
          rig_name = excluded.rig_name,
          seat_name = excluded.seat_name,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          duration_seconds = excluded.duration_seconds,
          log_dir = excluded.log_dir,
          source_hash = excluded.source_hash,
          parser_version = excluded.parser_version,
          ingested_at = datetime('now')
      `).run(run);

      let findingsUpserted = 0;
      let findingsDeleted = 0;

      if (findings !== null) {
        const findingStmt = this.db.prepare(`
          INSERT INTO review_findings (
            run_trace_id, finding_id, file, lines, category,
            hunter_key, stack, score, verdict,
            has_fix_spec, description_prefix, description_hash
          ) VALUES (
            @runTraceId, @findingId, @file, @lines, @category,
            @hunterKey, @stack, @score, @verdict,
            @hasFixSpec, @descriptionPrefix, @descriptionHash
          )
          ON CONFLICT(run_trace_id, finding_id) DO UPDATE SET
            file = excluded.file,
            lines = excluded.lines,
            category = excluded.category,
            hunter_key = excluded.hunter_key,
            stack = excluded.stack,
            score = excluded.score,
            verdict = excluded.verdict,
            has_fix_spec = excluded.has_fix_spec,
            description_prefix = excluded.description_prefix,
            description_hash = excluded.description_hash
        `);

        for (const f of findings) {
          findingStmt.run(f);
          findingsUpserted++;
        }

        if (findings.length > 0) {
          const placeholders = findings.map(() => "?").join(", ");
          const ids = findings.map((f) => f.findingId);
          const del = this.db.prepare(
            `DELETE FROM review_findings WHERE run_trace_id = ? AND finding_id NOT IN (${placeholders})`,
          ).run(run.traceId, ...ids);
          findingsDeleted = del.changes;
        } else if (existingRun) {
          const del = this.db.prepare(
            "DELETE FROM review_findings WHERE run_trace_id = ?",
          ).run(run.traceId);
          findingsDeleted = del.changes;
        }
      }

      return {
        runId: existingRun?.id ?? Number(runInfo.lastInsertRowid),
        created: !existingRun,
        findingsUpserted,
        findingsDeleted,
      };
    })();

    return result;
  }

  upsertSnapshot(s: DailyTokenSnapshotInput): { id: number; created: boolean } {
    const existing = this.db.prepare(
      "SELECT id FROM daily_token_snapshots WHERE day = ? AND seat_session = ?",
    ).get(s.day, s.seatSession) as { id: number } | undefined;

    const info = this.db.prepare(`
      INSERT INTO daily_token_snapshots (
        day, seat_session, rig_name, seat_name, model,
        input_tokens_delta, output_tokens_delta, total_tokens_delta,
        samples, resets, schema_version
      ) VALUES (
        @day, @seatSession, @rigName, @seatName, @model,
        @inputTokensDelta, @outputTokensDelta, @totalTokensDelta,
        @samples, @resets, @schemaVersion
      )
      ON CONFLICT(day, seat_session) DO UPDATE SET
        rig_name = excluded.rig_name,
        seat_name = excluded.seat_name,
        model = excluded.model,
        input_tokens_delta = excluded.input_tokens_delta,
        output_tokens_delta = excluded.output_tokens_delta,
        total_tokens_delta = excluded.total_tokens_delta,
        samples = excluded.samples,
        resets = excluded.resets,
        schema_version = excluded.schema_version,
        snapshot_at = datetime('now')
    `).run(s);

    return { id: existing?.id ?? Number(info.lastInsertRowid), created: !existing };
  }

  stats(): FleetStoreStats {
    const agg = (table: string, tsCol?: string) => {
      const sql = tsCol
        ? `SELECT COUNT(*) AS count, MAX(${tsCol}) AS ts FROM ${table}`
        : `SELECT COUNT(*) AS count FROM ${table}`;
      const row = this.db.prepare(sql).get() as { count: number; ts?: string | null };
      return { count: row.count, ts: row.ts ?? null };
    };

    const digestsRaw = this.db.prepare(
      "SELECT COUNT(*) AS count, MAX(ingested_at) AS ts, SUM(escalation_count) AS total_escalations FROM session_digests",
    ).get() as { count: number; ts: string | null; total_escalations: number | null };
    const runs = agg("review_runs", "ingested_at");
    const findings = agg("review_findings");
    const snapshots = agg("daily_token_snapshots", "snapshot_at");

    return {
      session_digests: {
        count: digestsRaw.count,
        last_ingested_at: digestsRaw.ts,
        total_escalations: digestsRaw.total_escalations ?? 0,
      },
      review_runs: { count: runs.count, last_ingested_at: runs.ts },
      review_findings: { count: findings.count },
      daily_token_snapshots: { count: snapshots.count, last_snapshot_at: snapshots.ts },
    };
  }

  upsertSnapshots(snapshots: DailyTokenSnapshotInput[]): { upserted: number } {
    let upserted = 0;
    this.db.transaction(() => {
      for (const s of snapshots) {
        this.upsertSnapshot(s);
        upserted++;
      }
    })();
    return { upserted };
  }

  listDigests(filter: ListFilter = {}): { rows: SessionDigestRow[]; total: number } {
    const { where, params } = this.buildWhere(filter, "rig_name", "seat_name", "ingested_at");
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM session_digests${where}`).get(...params) as { c: number }).c;
    const limit = clampLimit(filter.limit);
    const offset = clampOffset(filter.offset);
    const rows = this.db.prepare(`
      SELECT id, rig_name, seat_session, seat_name, native_session_id,
             total_turns, conversation_turns, transcript_bytes, ingested_at
      FROM session_digests${where}
      ORDER BY ingested_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SessionDigestRow[];
    return { rows, total };
  }

  listReviews(filter: ReviewListFilter = {}): { rows: ReviewRunRow[]; total: number } {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter.rig) { clauses.push("rig_name = ?"); params.push(filter.rig); }
    if (filter.seat) { clauses.push("seat_name = ?"); params.push(filter.seat); }
    if (filter.repo) { clauses.push("repo = ?"); params.push(filter.repo); }
    if (filter.branch) { clauses.push("branch = ?"); params.push(filter.branch); }
    if (filter.pr !== undefined) { clauses.push("pr_number = ?"); params.push(filter.pr); }
    if (filter.since) { clauses.push("completed_at >= ?"); params.push(filter.since); }
    if (filter.until) { clauses.push("completed_at <= ?"); params.push(normalizeUntilDate(filter.until)); }

    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM review_runs${where}`).get(...params) as { c: number }).c;
    const limit = clampLimit(filter.limit);
    const offset = clampOffset(filter.offset);
    const rows = this.db.prepare(`
      SELECT id, trace_id, pr_number, repo, branch, head_sha, mode,
             must_fix, suggestion, dismissed,
             rig_name, seat_name, completed_at, duration_seconds
      FROM review_runs${where}
      ORDER BY completed_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as ReviewRunRow[];
    return { rows, total };
  }

  getReviewFindings(traceId: string): ReviewFindingRow[] {
    return this.db.prepare(`
      SELECT id, run_trace_id, finding_id, file, lines, category,
             hunter_key, stack, score, verdict, description_prefix
      FROM review_findings
      WHERE run_trace_id = ?
      ORDER BY score DESC
    `).all(traceId) as ReviewFindingRow[];
  }

  checkReviewExists(repo: string, branch: string, headSha: string): {
    exists: boolean;
    traceId: string | null;
    completedAt: string | null;
  } {
    const row = this.db.prepare(`
      SELECT trace_id, completed_at
        FROM review_runs
       WHERE repo = ? AND branch = ? AND head_sha = ?
       ORDER BY completed_at DESC LIMIT 1
    `).get(repo, branch, headSha) as { trace_id: string; completed_at: string | null } | undefined;
    return {
      exists: row !== undefined,
      traceId: row?.trace_id ?? null,
      completedAt: row?.completed_at ?? null,
    };
  }

  listSnapshots(filter: ListFilter = {}): { rows: SnapshotRow[]; total: number } {
    const { where, params } = this.buildWhere(filter, "rig_name", "seat_name", "day");
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM daily_token_snapshots${where}`).get(...params) as { c: number }).c;
    const limit = clampLimit(filter.limit);
    const offset = clampOffset(filter.offset);
    const rows = this.db.prepare(`
      SELECT id, day, seat_session, rig_name, seat_name, model,
             input_tokens_delta, output_tokens_delta, total_tokens_delta,
             samples, snapshot_at
      FROM daily_token_snapshots${where}
      ORDER BY day DESC, rig_name ASC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SnapshotRow[];
    return { rows, total };
  }

  private aggregate<R extends Record<string, unknown>>(
    sql: string,
    params: unknown[],
    limit: number | undefined,
  ): AggregateResult<R> {
    const cap = clampAggLimit(limit);
    const raw = this.db.prepare(sql).all(...params, cap + 1) as R[];
    return { rows: raw.slice(0, cap), truncated: raw.length > cap };
  }

  /** Tokens per rig per day, from daily_token_snapshots. Groups on raw columns; NULL rig is labeled in JS. */
  tokensByRigDay(filter: AggregateFilter = {}): AggregateResult<TokensRigDayRow> {
    const { where, params } = this.buildWhere(filter, "rig_name", "seat_name", "day");
    const res = this.aggregate<Record<string, unknown>>(`
      SELECT day, rig_name,
             COALESCE(SUM(input_tokens_delta), 0) AS input_tokens,
             COALESCE(SUM(output_tokens_delta), 0) AS output_tokens,
             COALESCE(SUM(COALESCE(total_tokens_delta, COALESCE(input_tokens_delta, 0) + COALESCE(output_tokens_delta, 0))), 0) AS total_tokens,
             COUNT(DISTINCT seat_session) AS seats,
             COALESCE(SUM(samples), 0) AS samples
      FROM daily_token_snapshots${where}
      GROUP BY day, rig_name
      ORDER BY day DESC, rig_name ASC
      LIMIT ?
    `, params, filter.limit);
    return {
      truncated: res.truncated,
      rows: res.rows.map((r) => ({ ...r, rig_name: label(r.rig_name as string | null, UNATTRIBUTED) }) as unknown as TokensRigDayRow),
    };
  }

  /** Tokens per rig, seat and model, from daily_token_snapshots. Ordered by total tokens. */
  tokensBySeat(filter: AggregateFilter = {}): AggregateResult<TokensSeatRow> {
    const { where, params } = this.buildWhere(filter, "rig_name", "seat_name", "day");
    const res = this.aggregate<Record<string, unknown>>(`
      SELECT rig_name, seat_name, model,
             COALESCE(SUM(input_tokens_delta), 0) AS input_tokens,
             COALESCE(SUM(output_tokens_delta), 0) AS output_tokens,
             COALESCE(SUM(COALESCE(total_tokens_delta, COALESCE(input_tokens_delta, 0) + COALESCE(output_tokens_delta, 0))), 0) AS total_tokens,
             COUNT(DISTINCT day) AS days,
             COALESCE(SUM(samples), 0) AS samples
      FROM daily_token_snapshots${where}
      GROUP BY rig_name, seat_name, model
      ORDER BY total_tokens DESC, rig_name ASC, seat_name ASC
      LIMIT ?
    `, params, filter.limit);
    return {
      truncated: res.truncated,
      rows: res.rows.map((r) => ({
        ...r,
        rig_name: label(r.rig_name as string | null, UNATTRIBUTED),
        seat_name: label(r.seat_name as string | null, UNATTRIBUTED),
        model: label(r.model as string | null, UNKNOWN_MODEL),
      }) as unknown as TokensSeatRow),
    };
  }

  /**
   * Review runs per seat per week, from review_runs. A week starts on Monday (UTC date of
   * completed_at). Runs without a parseable completed_at group under "(undated)" unless a
   * since/until filter excludes them.
   */
  reviewsBySeatWeek(filter: AggregateFilter = {}): AggregateResult<ReviewsSeatWeekRow> {
    const { where, params } = this.buildWhere(filter, "rig_name", "seat_name", "completed_at");
    const res = this.aggregate<Record<string, unknown>>(`
      SELECT date(completed_at, 'weekday 0', '-6 days') AS week_start, rig_name, seat_name,
             COUNT(*) AS runs,
             COALESCE(SUM(must_fix), 0) AS must_fix,
             COALESCE(SUM(suggestion), 0) AS suggestion,
             COALESCE(SUM(dismissed), 0) AS dismissed
      FROM review_runs${where}
      GROUP BY week_start, rig_name, seat_name
      ORDER BY week_start DESC, rig_name ASC, seat_name ASC
      LIMIT ?
    `, params, filter.limit);
    return {
      truncated: res.truncated,
      rows: res.rows.map((r) => ({
        ...r,
        week_start: label(r.week_start as string | null, UNDATED),
        rig_name: label(r.rig_name as string | null, UNATTRIBUTED),
        seat_name: label(r.seat_name as string | null, UNATTRIBUTED),
      }) as unknown as ReviewsSeatWeekRow),
    };
  }

  /** Session digests per rig. since/until apply to ingested_at. */
  sessionsByRig(filter: AggregateFilter = {}): AggregateResult<SessionsRigRow> {
    const { where, params } = this.buildWhere(filter, "rig_name", "seat_name", "ingested_at");
    const res = this.aggregate<Record<string, unknown>>(`
      SELECT rig_name,
             COUNT(*) AS sessions,
             COALESCE(SUM(total_turns), 0) AS total_turns,
             COALESCE(SUM(conversation_turns), 0) AS conversation_turns,
             COALESCE(SUM(total_input_tokens), 0) AS input_tokens,
             COALESCE(SUM(total_output_tokens), 0) AS output_tokens,
             COALESCE(SUM(escalation_count), 0) AS escalations,
             MAX(ingested_at) AS last_ingested_at
      FROM session_digests${where}
      GROUP BY rig_name
      ORDER BY sessions DESC, rig_name ASC
      LIMIT ?
    `, params, filter.limit);
    return {
      truncated: res.truncated,
      rows: res.rows.map((r) => ({ ...r, rig_name: label(r.rig_name as string | null, UNATTRIBUTED) }) as unknown as SessionsRigRow),
    };
  }

  /** Headline numbers for the dashboard and `rig fleet summary`. One row per rig, plus fleet totals. */
  summary(filter: AggregateFilter = {}): FleetSummary {
    const sessions = this.sessionsByRig(filter);
    const tokens = this.aggregateTokensByRig(filter);
    const reviews = this.aggregateReviewsByRig(filter);
    const seats = this.tokensBySeat({ ...filter, limit: 10 });
    const weekly = this.reviewsBySeatWeek({ ...filter, limit: 50 });

    const byRig = new Map<string, FleetSummaryRig>();
    const row = (name: string): FleetSummaryRig => {
      let r = byRig.get(name);
      if (!r) {
        r = { rig_name: name, sessions: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, review_runs: 0, must_fix: 0, suggestion: 0, dismissed: 0 };
        byRig.set(name, r);
      }
      return r;
    };
    for (const s of sessions.rows) row(s.rig_name).sessions = s.sessions;
    for (const t of tokens.rows) Object.assign(row(t.rig_name), { input_tokens: t.input_tokens, output_tokens: t.output_tokens, total_tokens: t.total_tokens });
    for (const r of reviews.rows) Object.assign(row(r.rig_name), { review_runs: r.runs, must_fix: r.must_fix, suggestion: r.suggestion, dismissed: r.dismissed });

    const rigs = [...byRig.values()].sort((a, b) => b.total_tokens - a.total_tokens || a.rig_name.localeCompare(b.rig_name));
    const sum = (f: (r: FleetSummaryRig) => number) => rigs.reduce((n, r) => n + f(r), 0);
    return {
      totals: {
        rigs: rigs.length,
        sessions: sum((r) => r.sessions),
        input_tokens: sum((r) => r.input_tokens),
        output_tokens: sum((r) => r.output_tokens),
        total_tokens: sum((r) => r.total_tokens),
        review_runs: sum((r) => r.review_runs),
        must_fix: sum((r) => r.must_fix),
        suggestion: sum((r) => r.suggestion),
        dismissed: sum((r) => r.dismissed),
        escalations: sessions.rows.reduce((n, s) => n + s.escalations, 0),
      },
      rigs,
      top_seats: seats.rows,
      reviews_by_seat_week: weekly.rows,
      stats: this.stats(),
      truncated: sessions.truncated || tokens.truncated || reviews.truncated,
    };
  }

  private aggregateTokensByRig(filter: AggregateFilter): AggregateResult<{ rig_name: string; input_tokens: number; output_tokens: number; total_tokens: number }> {
    const { where, params } = this.buildWhere(filter, "rig_name", "seat_name", "day");
    const res = this.aggregate<Record<string, unknown>>(`
      SELECT rig_name,
             COALESCE(SUM(input_tokens_delta), 0) AS input_tokens,
             COALESCE(SUM(output_tokens_delta), 0) AS output_tokens,
             COALESCE(SUM(COALESCE(total_tokens_delta, COALESCE(input_tokens_delta, 0) + COALESCE(output_tokens_delta, 0))), 0) AS total_tokens
      FROM daily_token_snapshots${where}
      GROUP BY rig_name
      ORDER BY total_tokens DESC
      LIMIT ?
    `, params, filter.limit);
    return { truncated: res.truncated, rows: res.rows.map((r) => ({ ...r, rig_name: label(r.rig_name as string | null, UNATTRIBUTED) }) as never) };
  }

  private aggregateReviewsByRig(filter: AggregateFilter): AggregateResult<{ rig_name: string; runs: number; must_fix: number; suggestion: number; dismissed: number }> {
    const { where, params } = this.buildWhere(filter, "rig_name", "seat_name", "completed_at");
    const res = this.aggregate<Record<string, unknown>>(`
      SELECT rig_name, COUNT(*) AS runs,
             COALESCE(SUM(must_fix), 0) AS must_fix,
             COALESCE(SUM(suggestion), 0) AS suggestion,
             COALESCE(SUM(dismissed), 0) AS dismissed
      FROM review_runs${where}
      GROUP BY rig_name
      LIMIT ?
    `, params, filter.limit);
    return { truncated: res.truncated, rows: res.rows.map((r) => ({ ...r, rig_name: label(r.rig_name as string | null, UNATTRIBUTED) }) as never) };
  }

  private buildWhere(
    filter: ListFilter,
    rigCol: string,
    seatCol: string,
    dateCol: string,
  ): { where: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.rig) { clauses.push(`${rigCol} = ?`); params.push(filter.rig); }
    if (filter.seat) { clauses.push(`${seatCol} = ?`); params.push(filter.seat); }
    if (filter.since) { clauses.push(`${dateCol} >= ?`); params.push(filter.since); }
    if (filter.until) { clauses.push(`${dateCol} <= ?`); params.push(normalizeUntilDate(filter.until)); }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    return { where, params };
  }
}
