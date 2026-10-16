import type { FleetSummary } from "./fleet-store.js";

// ── Fleet dashboard (RIG-80): one self-contained HTML document, no scripts, no external assets. ──
// Rig, seat and model names come from ingested data and are untrusted: every value is escaped.

export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const nf = new Intl.NumberFormat("en-US");
const num = (n: number): string => escapeHtml(nf.format(n));

export interface DashboardOptions {
  /** Applied filters, shown in the header. */
  filters?: { rig?: string; seat?: string; since?: string; until?: string };
  generatedAt?: string;
}

function table(headers: string[], rows: string[][], numericFrom = 1): string {
  const head = headers.map((h, i) => `<th${i >= numericFrom ? ' class="n"' : ""}>${escapeHtml(h)}</th>`).join("");
  const body = rows
    .map((r) => `<tr>${r.map((c, i) => `<td${i >= numericFrom ? ' class="n"' : ""}>${c}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function empty(msg: string): string {
  return `<p class="empty">${escapeHtml(msg)}</p>`;
}

export function renderFleetDashboard(s: FleetSummary, opts: DashboardOptions = {}): string {
  const t = s.totals;
  const st = s.stats;
  const isEmpty =
    st.session_digests.count === 0 && st.review_runs.count === 0 && st.daily_token_snapshots.count === 0;

  const asOf = [
    ["session digests", st.session_digests.last_ingested_at],
    ["review runs", st.review_runs.last_ingested_at],
    ["token snapshots", st.daily_token_snapshots.last_snapshot_at],
  ]
    .map(([k, v]) => `${escapeHtml(k)}: ${escapeHtml(v ?? "never")}`)
    .join(" &middot; ");

  const f = opts.filters ?? {};
  const filterText = Object.entries(f)
    .filter(([, v]) => v)
    .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(v)}`)
    .join(" ");

  const tile = (labelText: string, value: string) =>
    `<div class="tile"><div class="v">${value}</div><div class="l">${escapeHtml(labelText)}</div></div>`;

  const rigRows = s.rigs.map((r) => [
    escapeHtml(r.rig_name),
    num(r.sessions),
    num(r.input_tokens),
    num(r.output_tokens),
    num(r.total_tokens),
    num(r.review_runs),
    num(r.must_fix),
  ]);
  const seatRows = s.top_seats.map((r) => [
    escapeHtml(r.rig_name),
    escapeHtml(r.seat_name),
    escapeHtml(r.model),
    num(r.input_tokens),
    num(r.output_tokens),
    num(r.total_tokens),
  ]);
  const weekRows = s.reviews_by_seat_week.map((r) => [
    escapeHtml(r.week_start),
    escapeHtml(r.rig_name),
    escapeHtml(r.seat_name),
    num(r.runs),
    num(r.must_fix),
    num(r.suggestion),
    num(r.dismissed),
  ]);

  const body = isEmpty
    ? `<section><p class="empty">The fleet store has no data yet. Run <code>rig fleet reconcile</code> to ingest session digests, review runs, and token snapshots.</p></section>`
    : `
<section class="tiles">
  ${tile("rigs", num(t.rigs))}
  ${tile("sessions", num(t.sessions))}
  ${tile("tokens in", num(t.input_tokens))}
  ${tile("tokens out", num(t.output_tokens))}
  ${tile("tokens total", num(t.total_tokens))}
  ${tile("review runs", num(t.review_runs))}
  ${tile("must-fix", num(t.must_fix))}
  ${tile("escalations", num(t.escalations))}
</section>
<section>
  <h2>Rig activity</h2>
  ${rigRows.length ? table(["Rig", "Sessions", "Tokens in", "Tokens out", "Tokens total", "Reviews", "Must-fix"], rigRows) : empty("No rig activity in this window.")}
</section>
<section>
  <h2>Token burn by seat (top ${num(s.top_seats.length)})</h2>
  ${seatRows.length ? table(["Rig", "Seat", "Model", "Tokens in", "Tokens out", "Tokens total"], seatRows, 3) : empty("No token snapshots in this window.")}
</section>
<section>
  <h2>Review coverage by seat per week</h2>
  ${weekRows.length ? table(["Week of (Mon)", "Rig", "Seat", "Runs", "Must-fix", "Suggestion", "Dismissed"], weekRows, 3) : empty("No review runs in this window.")}
</section>
${s.truncated ? `<p class="note">Some groups were truncated by the result cap. Narrow the window with --rig, --since or --until.</p>` : ""}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet dashboard</title>
<style>
:root{--bg:#fff;--fg:#1b1f24;--muted:#5b6570;--line:#d8dde3;--card:#f5f7f9;--accent:#0b5fff}
@media (prefers-color-scheme:dark){:root{--bg:#10141a;--fg:#e6e9ed;--muted:#97a1ac;--line:#2a313a;--card:#171c23;--accent:#6ea1ff}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto}
h1{font-size:1.4rem;margin:0 0 4px}
h2{font-size:1.05rem;margin:24px 0 8px}
.sub{color:var(--muted);font-size:.85rem;margin:0 0 4px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-top:16px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.tile .v{font-size:1.3rem;font-weight:600;font-variant-numeric:tabular-nums}
.tile .l{color:var(--muted);font-size:.8rem}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{color:var(--muted);font-weight:600;font-size:.8rem}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.empty,.note{color:var(--muted);background:var(--card);border:1px dashed var(--line);border-radius:8px;padding:12px}
code{font-family:ui-monospace,Menlo,monospace}
</style>
</head>
<body>
<main>
<h1>Fleet dashboard</h1>
<p class="sub">Data as of &mdash; ${asOf}</p>
<p class="sub">Units: tokens (no dollar pricing).${filterText ? ` Filters: ${filterText}.` : ""}${opts.generatedAt ? ` Rendered ${escapeHtml(opts.generatedAt)}.` : ""}</p>
${body}
</main>
</body>
</html>
`;
}
