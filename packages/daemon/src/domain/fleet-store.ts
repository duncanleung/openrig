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
  claudeMdLoaded: string;
  errors: string;
  irreversibleActions: string;
  compactionBoundaries: string;
  compactionLosses: string;
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
  session_digests: { count: number; last_ingested_at: string | null };
  review_runs: { count: number; last_ingested_at: string | null };
  review_findings: { count: number };
  daily_token_snapshots: { count: number; last_snapshot_at: string | null };
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
        tool_calls, repeated_reads, review_findings, handoff_events,
        claude_md_loaded, errors, irreversible_actions,
        compaction_boundaries, compaction_losses,
        source_hash, parser_version
      ) VALUES (
        @rigName, @seatSession, @seatName, @nodeLogicalId, @rigId, @nodeId,
        @nativeSessionId, @generationUuid, @occupantGeneration,
        @transcriptPath, @transcriptBytes, @transcriptModifiedAt,
        @totalTurns, @conversationTurns,
        @toolCalls, @repeatedReads, @reviewFindings, @handoffEvents,
        @claudeMdLoaded, @errors, @irreversibleActions,
        @compactionBoundaries, @compactionLosses,
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
        claude_md_loaded = excluded.claude_md_loaded,
        errors = excluded.errors,
        irreversible_actions = excluded.irreversible_actions,
        compaction_boundaries = excluded.compaction_boundaries,
        compaction_losses = excluded.compaction_losses,
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

    const digests = agg("session_digests", "ingested_at");
    const runs = agg("review_runs", "ingested_at");
    const findings = agg("review_findings");
    const snapshots = agg("daily_token_snapshots", "snapshot_at");

    return {
      session_digests: { count: digests.count, last_ingested_at: digests.ts },
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
}
