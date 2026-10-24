# Turn-anomaly watchdog (RIG-79)

Finds sessions whose assistant turns run far ahead of the user messages that steer them. It is advisory: it reports and
notifies, and it never stops, restarts or edits a session.

## Metric

`assistant turns : user messages`, taken from the fleet store (`session_digests.total_turns` and
`conversation_turns`). `total_turns` counts assistant messages that carry text or `tool_use` blocks, not individual tool
calls. `conversation_turns` counts user messages that are not tool results; compaction summaries are included.

The counters are lifetime totals, so the detector compares the current digest with its own earlier sample (the newest
sample at or before the window start). The default window is 30 minutes. The detector records samples itself because the
fleet store keeps one row per session and no history. A window needs half its length of sampled history before it can
raise a finding, so a new session or a daemon restart is "warming" for up to 15 minutes.

The test is `assistantDelta > threshold * userDelta` (multiplication, no integer division). A window with assistant turns
and no user messages has no ratio. It is its own finding kind, `zero_conversation`, and is flagged when the assistant
turns exceed the role threshold.

## Role thresholds

| Role | Threshold | Derived from |
|---|---|---|
| orchestrator | 50:1 | `orch` / `lead` in the member or logical id |
| reviewer | 40:1 | `review` in the member or logical id |
| implementer | 20:1 | `impl` / `dev` / `builder` / `qa` |
| other | 30:1 | anything else |

`TurnAnomalyDetector` takes `config.thresholds`, `config.windowMs` and `config.roleOverrides` (seat session or logical id
to role). The daemon uses the defaults.

## Where findings appear

- `GET /api/health/operational` (and `rig health --operational`): the `turnAnomalies` section, with session, kind, role,
  window, ratio, threshold, lifetime zero-conversation flag and in-window reducer stall patterns (`read-storm`,
  `retry-loop`, `stall`) as corroboration. A missing or stale detector shows as a coverage gap, so the verdict is
  `indeterminate`, not `clear`.
- The `turn-anomaly` watchdog policy (`rig watchdog register --policy turn-anomaly --target <orchestrator>`) sends one
  message to its target when the set of open episodes changes. Health does not depend on this job and ignores its
  suppression.

The watched session and the notice recipient are separate. The episode records the watched session's native session id and
generation. The watchdog engine's `targetGeneration` describes only the recipient.

## Limits

- **Latency.** The detector reads the fleet store, not transcripts. Fleet ingestion runs on a 5-minute default cadence, so
  a pattern shorter than that is invisible, and a finding appears up to one ingestion interval plus one scan interval
  (1 minute) after the pattern starts.
- **Local Claude transcripts only.** The fleet store does not see other runtimes or other hosts.
- **A high ratio is not proof of no progress.** Orchestrators and reviewers legitimately run high ratios; use the role
  thresholds and read the corroboration before acting.
- **Fleet-store schema.** The detector reports `unavailable` coverage when the database has no `session_digests` table.
