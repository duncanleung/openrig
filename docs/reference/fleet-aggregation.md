# Fleet aggregation

Fleet aggregation rolls up the fleet store (session digests, review runs, daily token snapshots) by rig and seat. All endpoints are read-only `GET` routes under `/api/fleet`. They need no bearer token, like the other fleet read routes.

All token values are **tokens**. OpenRig has no pricing table, so there is no dollar cost. "Cost attribution" means token attribution by rig, seat, and model.

## Endpoints

| Endpoint | Source table | Groups by |
|---|---|---|
| `GET /api/fleet/aggregate/tokens?by=rig-day` (default) | `daily_token_snapshots` | day, rig |
| `GET /api/fleet/aggregate/tokens?by=seat` | `daily_token_snapshots` | rig, seat, model (ordered by total tokens) |
| `GET /api/fleet/aggregate/reviews` | `review_runs` | week, rig, seat |
| `GET /api/fleet/aggregate/sessions` | `session_digests` | rig |
| `GET /api/fleet/summary` | all three plus `stats` | rig (plus fleet totals, top 10 seats, weekly reviews) |
| `GET /api/fleet/dashboard` | same as `summary` | returns `text/html` |

### Query parameters

| Parameter | Meaning |
|---|---|
| `rig`, `seat` | Exact match filter. |
| `since`, `until` | Window bounds, `YYYY-MM-DD` only. `until` includes the whole day. A full timestamp returns `400 invalid_field`. The stored timestamps use two formats, so only date-only bounds compare correctly. |
| `limit` | Maximum groups, 1 to 500, default 200. |
| `by` | Tokens only: `rig-day` or `seat`. |

The window applies to: `day` (tokens), `completed_at` (reviews), `ingested_at` (sessions).

### Response shape

Group endpoints return `{ ok, rows, truncated }`. `truncated` is `true` when more groups existed than `limit`. The tokens endpoint also echoes `by`.

- tokens, `rig-day`: `day, rig_name, input_tokens, output_tokens, total_tokens, seats, samples`
- tokens, `seat`: `rig_name, seat_name, model, input_tokens, output_tokens, total_tokens, days, samples`
- reviews: `week_start, rig_name, seat_name, runs, must_fix, suggestion, dismissed`
- sessions: `rig_name, sessions, total_turns, conversation_turns, input_tokens, output_tokens, escalations, last_ingested_at`

`/summary` returns `{ ok, summary: { totals, rigs, top_seats, reviews_by_seat_week, stats, truncated } }`. `stats` is the same object as `GET /api/fleet/stats`, so the last-ingest timestamps are in `summary.stats`.

Errors use the same shape as the other fleet routes: `400 { code: "invalid_field" }` for bad parameters and `500 { code: "fleet_store_error" }`.

`total_tokens` uses `total_tokens_delta`. When that value is `NULL`, it falls back to input plus output.

## Week definition

`week_start` is the **Monday (UTC date)** of the week that contains `completed_at`, as `YYYY-MM-DD`. A Sunday belongs to the week that started the previous Monday. Review runs without a parseable `completed_at` group under `(undated)`. A `since` or `until` filter excludes them.

## Unattributed bucket

Rows with `NULL` or empty `rig_name` or `seat_name` group under `(unattributed)`. A `NULL` model groups under `(unknown)`. No row is dropped. Filtering with `rig=` or `seat=` matches stored names only, so it cannot select the unattributed bucket.

## Dashboard

`GET /api/fleet/dashboard` returns one self-contained HTML document: no scripts, no external fonts or assets, light and dark mode through `prefers-color-scheme`. It shows fleet totals, a per-rig table, top seats by token use, reviews per seat per week, and a "data as of" line from the last ingest timestamps. An empty store shows an empty state. Rig, seat, and model names come from ingested data and are HTML-escaped.

## CLI

```bash
rig fleet summary [--rig <name>] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--json]
rig fleet aggregate <tokens|reviews|sessions> [--by rig-day|seat] [--rig] [--seat] [--since] [--until] [--limit] [--json]
rig fleet dashboard [--out ./fleet-dashboard.html] [--rig] [--since] [--until]
```

`rig fleet dashboard` writes the HTML to a local file and prints the absolute path. It does not open a browser and does not publish anything.

## Performance notes

Queries group on raw indexed columns (`rig_name`, `day`) and map `NULL` to the label in code. `review_runs.completed_at` has no index, so review rollups scan the table. The tables hold one row per session, review, or seat-day, so this is acceptable. No migration or new index was added.
