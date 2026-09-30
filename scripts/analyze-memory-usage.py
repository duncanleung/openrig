#!/usr/bin/env python3
"""Transcript memory-surface analyzer.

Parses Claude JSONL transcripts and measures how agents interact with
OpenRig's 11 memory persistence surfaces. Produces a structured JSON
report and a human-readable summary.

Signals measured:
  - observation_coverage: fraction of sessions touching any memory surface
  - delivery_coverage:    fraction of sessions where startup delivered memory content
  - surface_activity:     read/write counts per surface per session
  - skill_invocations:    memory-related skill calls per session
  - read_write_ratio:     per-surface ratio (consumed vs. produced)
  - delivery_manifests:   event-based delivery records from the daemon events table

Usage:
  python3 scripts/analyze-memory-usage.py [--project <project-dir>] [--json] [--sessions N] [--db <path>]

  --project   Claude project transcript directory
              (default: ~/.claude/projects/-Users-*-openrig/)
  --json      Output raw JSON report instead of human-readable summary
  --sessions  Limit to the N most recent sessions (default: all)
  --db        OpenRig SQLite database path (default: ~/.openrig/openrig.sqlite)
"""

import argparse
import glob
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

# Classifies *transcript tool-use activity* into a surface label, for the
# "Surface Activity" section of the report. This taxonomy is independently
# maintained from SURFACE_PATTERNS/classifyDeliveredSurface in
# packages/daemon/src/domain/startup-orchestrator.ts, which classifies
# *delivered files* (a different signal, read from the daemon's
# node.startup_delivery_manifest surfaceCounts payload) for the "Delivery
# Manifests" section printed alongside it. The label sets don't align 1:1 —
# see the mapping comment above SURFACE_PATTERNS in that file — so update
# both if you rename or split a surface here.
MEMORY_SURFACES = {
    "auto-memory": {
        "patterns": ["memory/", "MEMORY.md"],
        "tier": "T7-host-local",
    },
    "wiki": {
        "patterns": ["wiki/"],
        "tier": "T4-project-evidence",
    },
    "project-guidance": {
        "patterns": ["openrig-project-guidance", "CLAUDE.md"],
        "tier": "T1-instruction",
    },
    "seat-lessons": {
        "patterns": ["LEARNED.md"],
        "tier": "T2-positional",
    },
    "work-observations": {
        "patterns": ["NOTES.md"],
        "tier": "T3-work-tree",
    },
    "restore-packet": {
        "patterns": ["restore-packet", "restore_packet"],
        "tier": "T6-session-evidence",
    },
    "adr": {
        "patterns": ["docs/decisions/"],
        "tier": "T4-project-evidence",
    },
    "role-guidance": {
        "patterns": ["agent_spec", "role-guidance", "openrig-start"],
        "tier": "T1-instruction",
    },
    "queue": {
        "patterns": ["rig queue", "queue create", "queue claim"],
        "tier": "T5-communication",
    },
    "context-pack": {
        "patterns": ["context-pack", "rig context"],
        "tier": "T1-instruction",
    },
    "peer-messages": {
        "patterns": ["rig send", "rig capture", "SendMessage"],
        "tier": "T5-communication",
    },
}

READ_TOOLS = {"Read", "Bash", "Grep", "Explore", "Agent"}
WRITE_TOOLS = {"Write", "Edit"}
MEMORY_SKILLS = {
    "wiki-update", "adr-create", "codex-second-opinion",
    "symmetric-debate", "solution-design", "deep-research-plus",
    "claude-compaction-restore",
}


def classify_operation(tool_name):
    if tool_name in WRITE_TOOLS:
        return "write"
    if tool_name in READ_TOOLS:
        return "read"
    if tool_name == "Skill":
        return "skill"
    return "other"


def match_surface(text):
    for surface, config in MEMORY_SURFACES.items():
        for pattern in config["patterns"]:
            if pattern in text:
                return surface
    return None


def parse_session(jsonl_path):
    """Parse one transcript JSONL into a memory interaction report."""
    session_id = Path(jsonl_path).stem
    file_size = os.path.getsize(jsonl_path)

    interactions = []
    skill_invocations = []
    total_tool_uses = 0
    total_lines = 0
    first_ts = None
    last_ts = None
    startup_delivery = {
        "wiki_delivered": False,
        "memory_delivered": False,
        "claude_md_delivered": False,
        "guidance_delivered": False,
    }

    with open(jsonl_path, "r", errors="replace") as f:
        for raw_line in f:
            raw_line = raw_line.strip()
            if not raw_line:
                continue
            total_lines += 1

            try:
                record = json.loads(raw_line)
            except json.JSONDecodeError:
                continue

            ts = record.get("timestamp")
            if ts and first_ts is None:
                first_ts = ts
            if ts:
                last_ts = ts

            record_type = record.get("type", "")

            # Detect startup delivery in user messages (system-reminder content)
            if record_type == "user":
                msg = record.get("message", {})
                content = msg.get("content", "")
                if isinstance(content, list):
                    content = " ".join(
                        p.get("text", "") if isinstance(p, dict) else str(p)
                        for p in content
                    )
                if isinstance(content, str):
                    content_lower = content.lower()
                    if "wiki" in content_lower and "system-reminder" in content:
                        startup_delivery["wiki_delivered"] = True
                    if "memory" in content_lower and "system-reminder" in content:
                        startup_delivery["memory_delivered"] = True
                    if "claude.md" in content_lower and "system-reminder" in content:
                        startup_delivery["claude_md_delivered"] = True
                    if "project guidance" in content_lower or "openrig-project-guidance" in content:
                        startup_delivery["guidance_delivered"] = True

            # Extract tool_use from assistant messages
            if record_type != "assistant":
                continue
            msg = record.get("message", {})
            content = msg.get("content", [])
            if not isinstance(content, list):
                continue

            for part in content:
                if not isinstance(part, dict):
                    continue
                if part.get("type") != "tool_use":
                    continue

                total_tool_uses += 1
                tool_name = part.get("name", "")
                tool_input = part.get("input", {})
                input_str = json.dumps(tool_input) if isinstance(tool_input, dict) else str(tool_input)

                # Track skill invocations
                if tool_name == "Skill":
                    skill_name = tool_input.get("skill", "") if isinstance(tool_input, dict) else ""
                    if skill_name:
                        skill_invocations.append(skill_name)

                # Match against memory surfaces
                surface = match_surface(input_str)
                if surface:
                    op = classify_operation(tool_name)
                    file_path = ""
                    if isinstance(tool_input, dict):
                        file_path = tool_input.get("file_path", tool_input.get("command", ""))
                        if isinstance(file_path, str):
                            file_path = file_path[:200]
                        else:
                            file_path = ""

                    interactions.append({
                        "surface": surface,
                        "tool": tool_name,
                        "operation": op,
                        "timestamp": ts,
                        "file_path": file_path,
                    })

    # Aggregate per surface
    surface_stats = {}
    for surface in MEMORY_SURFACES:
        surface_interactions = [i for i in interactions if i["surface"] == surface]
        if not surface_interactions:
            continue
        reads = sum(1 for i in surface_interactions if i["operation"] == "read")
        writes = sum(1 for i in surface_interactions if i["operation"] == "write")
        others = sum(1 for i in surface_interactions if i["operation"] not in ("read", "write"))
        tools = Counter(i["tool"] for i in surface_interactions)
        surface_stats[surface] = {
            "total": len(surface_interactions),
            "reads": reads,
            "writes": writes,
            "other": others,
            "tools": dict(tools.most_common()),
            "tier": MEMORY_SURFACES[surface]["tier"],
        }

    memory_skills = [s for s in skill_invocations if s in MEMORY_SKILLS]

    return {
        "session_id": session_id,
        "file_size": file_size,
        "total_lines": total_lines,
        "total_tool_uses": total_tool_uses,
        "first_timestamp": first_ts,
        "last_timestamp": last_ts,
        "memory_interactions": {
            "total": len(interactions),
            "by_surface": surface_stats,
        },
        "startup_delivery": startup_delivery,
        "skill_invocations": skill_invocations,
        "memory_skill_invocations": memory_skills,
    }


def aggregate(sessions):
    """Compute cross-session aggregates."""
    if not sessions:
        return {}

    total = len(sessions)
    sessions_with_memory = sum(
        1 for s in sessions if s["memory_interactions"]["total"] > 0
    )
    sessions_with_delivery = sum(
        1 for s in sessions
        if any(s["startup_delivery"].values())
    )

    surface_agg = {}
    for surface in MEMORY_SURFACES:
        sessions_reading = 0
        sessions_writing = 0
        total_reads = 0
        total_writes = 0
        for s in sessions:
            stats = s["memory_interactions"]["by_surface"].get(surface, {})
            if stats.get("reads", 0) > 0:
                sessions_reading += 1
                total_reads += stats["reads"]
            if stats.get("writes", 0) > 0:
                sessions_writing += 1
                total_writes += stats["writes"]

        if total_reads + total_writes > 0:
            surface_agg[surface] = {
                "sessions_reading": sessions_reading,
                "sessions_writing": sessions_writing,
                "total_reads": total_reads,
                "total_writes": total_writes,
                "read_write_ratio": round(total_reads / max(total_writes, 1), 2),
                "tier": MEMORY_SURFACES[surface]["tier"],
            }

    skill_counts = Counter()
    for s in sessions:
        for sk in s["memory_skill_invocations"]:
            skill_counts[sk] += 1

    return {
        "session_count": total,
        "observation_coverage": round(sessions_with_memory / max(total, 1), 3),
        "delivery_coverage": round(sessions_with_delivery / max(total, 1), 3),
        "surface_activity": surface_agg,
        "skill_usage": dict(skill_counts.most_common()),
    }


def print_summary(report):
    """Print human-readable summary."""
    meta = report["meta"]
    agg = report["aggregate"]

    if not agg:
        print("No sessions parsed — nothing to report.")
        return

    print("=" * 60)
    print("  Memory Surface Usage Report")
    print("=" * 60)
    print(f"  Project:    {meta['project']}")
    print(f"  Analyzed:   {meta['analyzed_at'][:19]}")
    print(f"  Sessions:   {agg['session_count']}")
    print()

    print("  Coverage")
    print("  " + "-" * 40)
    n = agg["session_count"]
    obs = agg["observation_coverage"]
    del_ = agg["delivery_coverage"]
    print(f"  Observation: {obs:.0%}  ({round(obs * n)}/{n} sessions touch memory)")
    print(f"  Delivery:    {del_:.0%}  ({round(del_ * n)}/{n} sessions receive startup delivery)")
    print()

    print("  Surface Activity")
    print("  " + "-" * 58)
    print(f"  {'Surface':<20} {'Tier':<20} {'Reads':>6} {'Writes':>7} {'R/W':>5}")
    print("  " + "-" * 58)
    for surface, stats in sorted(
        agg["surface_activity"].items(),
        key=lambda x: -(x[1]["total_reads"] + x[1]["total_writes"]),
    ):
        print(
            f"  {surface:<20} {stats['tier']:<20} "
            f"{stats['total_reads']:>6} {stats['total_writes']:>7} "
            f"{stats['read_write_ratio']:>5.1f}"
        )
    print()

    if agg.get("skill_usage"):
        print("  Memory Skill Usage")
        print("  " + "-" * 40)
        for skill, count in sorted(agg["skill_usage"].items(), key=lambda x: -x[1]):
            print(f"  {skill:<30} {count:>3} invocations")
        print()

    # Delivery manifests (event-based, from daemon)
    dm = report.get("delivery_manifests", {})
    if dm.get("available"):
        print("  Delivery Manifests (daemon events)")
        print("  " + "-" * 58)
        if dm["manifest_count"] == 0:
            print(f"  No manifests yet ({dm['total_startups']} startups recorded)")
            print(f"  {dm.get('note', 'restart daemon to begin collecting')}")
        else:
            rate = dm.get("delivery_rate", 0)
            print(f"  Manifests:   {dm['manifest_count']}/{dm['total_startups']} startups "
                  f"({rate:.0%} coverage)")
            if dm.get("surface_totals"):
                print(f"  Surfaces delivered:")
                for surface, count in sorted(dm["surface_totals"].items(), key=lambda x: -x[1]):
                    print(f"    {surface:<20} {count:>4} files")
        print()
    elif dm.get("reason"):
        print(f"  Delivery Manifests: unavailable ({dm['reason']})")
        print()

    # Per-session detail (top 5 by interaction count)
    sessions = sorted(
        report["sessions"],
        key=lambda s: -s["memory_interactions"]["total"],
    )
    print("  Top Sessions by Memory Activity")
    print("  " + "-" * 58)
    for s in sessions[:5]:
        mi = s["memory_interactions"]
        surfaces_touched = list(mi["by_surface"].keys())
        print(f"  {s['session_id'][:12]}…  {mi['total']:>4} interactions  "
              f"tools={s['total_tool_uses']}  "
              f"surfaces=[{', '.join(surfaces_touched[:4])}]")
    print()


def query_delivery_manifests(db_path):
    """Query delivery manifest events from the OpenRig events table."""
    if not os.path.exists(db_path):
        return {"available": False, "reason": f"database not found: {db_path}"}

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row

        rows = conn.execute(
            "SELECT node_id, payload, created_at FROM events "
            "WHERE type = 'node.startup_delivery_manifest' "
            "ORDER BY created_at DESC"
        ).fetchall()

        if not rows:
            total_startups = conn.execute(
                "SELECT count(*) FROM events WHERE type = 'node.startup_ready'"
            ).fetchone()[0]
            conn.close()
            return {
                "available": True,
                "manifest_count": 0,
                "total_startups": total_startups,
                "note": "no manifests yet — daemon needs restart with new code",
                "manifests": [],
            }

        manifests = []
        for row in rows:
            try:
                payload = json.loads(row["payload"])
                manifests.append({
                    "node_id": row["node_id"],
                    "created_at": row["created_at"],
                    "session_name": payload.get("sessionName", ""),
                    "summary": payload.get("summary", {}),
                    "file_count": len(payload.get("deliveredFiles", [])),
                    "surfaces": list(payload.get("summary", {}).get("surfaceCounts", {}).keys()),
                })
            except (json.JSONDecodeError, KeyError):
                continue

        total_startups = conn.execute(
            "SELECT count(*) FROM events WHERE type = 'node.startup_ready'"
        ).fetchone()[0]
        conn.close()

        surface_totals = Counter()
        for m in manifests:
            for surface, count in m.get("summary", {}).get("surfaceCounts", {}).items():
                surface_totals[surface] += count

        return {
            "available": True,
            "manifest_count": len(manifests),
            "total_startups": total_startups,
            "delivery_rate": round(len(manifests) / max(total_startups, 1), 3),
            "surface_totals": dict(surface_totals.most_common()),
            "manifests": manifests,
        }
    except sqlite3.Error as e:
        return {"available": False, "reason": str(e)}


# implicit_access: True means the surface is consumed via startup injection
# (guidance_merge), not via explicit tool calls. Transcript analysis cannot
# observe these reads, so delivery itself counts as access.
DECAY_THRESHOLDS = {
    "wiki": {"stale_after_sessions": 5, "weight": 1.0, "implicit_access": False},
    "adr": {"stale_after_sessions": 10, "weight": 0.8, "implicit_access": False},
    "auto-memory": {"stale_after_sessions": 8, "weight": 1.0, "implicit_access": False},
    "seat-lessons": {"stale_after_sessions": 6, "weight": 0.9, "implicit_access": False},
    "restore-packet": {"stale_after_sessions": 2, "weight": 0.5, "implicit_access": False},
    "context-pack": {"stale_after_sessions": 7, "weight": 0.8, "implicit_access": False},
    "role-guidance": {"stale_after_sessions": 15, "weight": 0.6, "implicit_access": True},
    "project-guidance": {"stale_after_sessions": 15, "weight": 0.6, "implicit_access": True},
    "work-observations": {"stale_after_sessions": 3, "weight": 0.7, "implicit_access": False},
    "queue": {"stale_after_sessions": 3, "weight": 0.9, "implicit_access": False},
    "peer-messages": {"stale_after_sessions": 3, "weight": 0.5, "implicit_access": False},
    "guidance": {"stale_after_sessions": 15, "weight": 0.4, "implicit_access": True},
    "skill": {"stale_after_sessions": 15, "weight": 0.4, "implicit_access": True},
}


def compute_staleness(sessions, delivery_data):
    """Join delivery manifests with transcript access data to compute per-surface staleness.

    Returns a dict with:
      - per_surface: {surface: {delivered, accessed, last_accessed_session, staleness_score, stale}}
      - per_file: [{path, surface, delivered_count, accessed_count, staleness_score, stale}]
      - stale_count: total files flagged as stale
      - healthy_count: total files not stale
    """
    if not delivery_data.get("available") or delivery_data.get("manifest_count", 0) == 0:
        return {"available": False, "reason": "no delivery manifests"}

    session_count = len(sessions)
    if session_count == 0:
        return {"available": False, "reason": "no sessions parsed"}

    # Build per-surface access counts from transcript data
    surface_access = defaultdict(lambda: {
        "sessions_accessing": 0,
        "total_reads": 0,
        "total_writes": 0,
        "last_accessed_idx": -1,
    })
    for idx, s in enumerate(sessions):
        for surface, stats in s["memory_interactions"]["by_surface"].items():
            sa = surface_access[surface]
            sa["sessions_accessing"] += 1
            sa["total_reads"] += stats.get("reads", 0)
            sa["total_writes"] += stats.get("writes", 0)
            sa["last_accessed_idx"] = max(sa["last_accessed_idx"], idx)

    # Build per-file delivery counts from manifests
    file_delivery = defaultdict(lambda: {"count": 0, "surface": "other", "content_hashes": set()})
    for m in delivery_data.get("manifests", []):
        summary = m.get("summary", {})
        surface_counts = summary.get("surfaceCounts", {})
        for surface, count in surface_counts.items():
            file_delivery[surface]["count"] += count

    # Build per-surface delivery counts
    surface_delivery = defaultdict(int)
    for surface, count in delivery_data.get("surface_totals", {}).items():
        surface_delivery[surface] = count

    # Compute per-surface staleness
    per_surface = {}
    for surface in set(list(surface_delivery.keys()) + list(surface_access.keys())):
        delivered = surface_delivery.get(surface, 0)
        sa = surface_access.get(surface, {
            "sessions_accessing": 0, "total_reads": 0,
            "total_writes": 0, "last_accessed_idx": -1,
        })
        accessed = sa["sessions_accessing"]
        last_idx = sa["last_accessed_idx"]

        threshold_cfg = DECAY_THRESHOLDS.get(surface, {
            "stale_after_sessions": 5, "weight": 1.0, "implicit_access": False,
        })
        threshold = threshold_cfg["stale_after_sessions"]
        weight = threshold_cfg["weight"]
        implicit = threshold_cfg.get("implicit_access", False)

        # Surfaces delivered via guidance_merge are consumed implicitly at
        # startup — the agent reads them but no tool_use event appears in the
        # transcript. Treat delivery as access for these surfaces.
        if implicit and delivered > 0 and accessed == 0:
            accessed = min(delivered, session_count)
            last_idx = session_count - 1

        sessions_since_access = session_count - last_idx - 1 if last_idx >= 0 else session_count
        access_ratio = accessed / max(session_count, 1)

        # Staleness score: 0.0 = fresh, 1.0 = fully stale
        if accessed == 0 and delivered > 0:
            staleness_score = 1.0
        elif accessed == 0:
            staleness_score = 0.0
        else:
            recency = min(sessions_since_access / max(threshold, 1), 1.0)
            frequency = 1.0 - min(access_ratio, 1.0)
            staleness_score = round((recency * 0.6 + frequency * 0.4) * weight, 3)

        per_surface[surface] = {
            "delivered": delivered,
            "accessed": accessed,
            "total_reads": sa["total_reads"],
            "total_writes": sa["total_writes"],
            "sessions_since_access": sessions_since_access,
            "staleness_score": staleness_score,
            "stale": staleness_score >= 0.7 and delivered > 0,
            "threshold": threshold,
            "implicit_access": implicit,
        }

    stale_surfaces = [s for s, v in per_surface.items() if v["stale"]]
    healthy_surfaces = [s for s, v in per_surface.items() if not v["stale"]]

    return {
        "available": True,
        "session_count": session_count,
        "manifest_count": delivery_data["manifest_count"],
        "per_surface": per_surface,
        "stale_surfaces": stale_surfaces,
        "healthy_surfaces": healthy_surfaces,
        "stale_count": len(stale_surfaces),
        "healthy_count": len(healthy_surfaces),
    }


def print_staleness_report(staleness):
    """Print human-readable staleness report."""
    if not staleness.get("available"):
        print(f"  Staleness Analysis: unavailable ({staleness.get('reason', 'unknown')})")
        print()
        return

    print("  Staleness Analysis (access-weighted retention)")
    print("  " + "-" * 58)
    print(f"  Sessions analyzed: {staleness['session_count']}   "
          f"Manifests: {staleness['manifest_count']}")
    print(f"  Stale: {staleness['stale_count']}   Healthy: {staleness['healthy_count']}")
    print()

    print(f"  {'Surface':<20} {'Delivered':>9} {'Accessed':>9} "
          f"{'Since':>6} {'Score':>6} {'Status':>8}")
    print("  " + "-" * 58)
    for surface, stats in sorted(
        staleness["per_surface"].items(),
        key=lambda x: -x[1]["staleness_score"],
    ):
        status = "STALE" if stats["stale"] else "ok"
        print(
            f"  {surface:<20} {stats['delivered']:>9} {stats['accessed']:>9} "
            f"{stats['sessions_since_access']:>6} {stats['staleness_score']:>6.2f} "
            f"{status:>8}"
        )
    print()

    if staleness["stale_surfaces"]:
        print("  Decay candidates:")
        for surface in staleness["stale_surfaces"]:
            stats = staleness["per_surface"][surface]
            print(f"    {surface}: delivered {stats['delivered']}x, "
                  f"accessed {stats['accessed']}x, "
                  f"stale for {stats['sessions_since_access']} sessions "
                  f"(threshold: {stats['threshold']})")
        print()


def find_project_dir(hint=None):
    """Find the transcript directory for this project."""
    if hint and os.path.isdir(hint):
        return hint

    base = os.path.expanduser("~/.claude/projects")
    candidates = glob.glob(os.path.join(base, "*openrig*"))
    if candidates:
        return sorted(candidates, key=os.path.getmtime, reverse=True)[0]

    return base


def main():
    parser = argparse.ArgumentParser(description="Analyze memory surface usage in Claude transcripts")
    parser.add_argument("--project", help="Claude project transcript directory")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    parser.add_argument("--sessions", type=int, default=0, help="Limit to N most recent sessions (0=all)")
    parser.add_argument("--db", default=os.path.expanduser("~/.openrig/openrig.sqlite"),
                        help="OpenRig SQLite database path")
    args = parser.parse_args()

    project_dir = find_project_dir(args.project)
    jsonl_files = sorted(
        glob.glob(os.path.join(project_dir, "*.jsonl")),
        key=os.path.getmtime,
        reverse=True,
    )

    if not jsonl_files:
        print(f"No .jsonl files found in {project_dir}", file=sys.stderr)
        sys.exit(1)

    if args.sessions > 0:
        jsonl_files = jsonl_files[: args.sessions]

    sessions = []
    for f in jsonl_files:
        try:
            sessions.append(parse_session(f))
        except Exception as e:
            print(f"  skip {os.path.basename(f)}: {e}", file=sys.stderr)

    delivery_data = query_delivery_manifests(args.db)
    staleness_data = compute_staleness(sessions, delivery_data)

    report = {
        "meta": {
            "project": os.path.basename(project_dir),
            "project_dir": project_dir,
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "transcript_count": len(jsonl_files),
            "db_path": args.db,
        },
        "sessions": sessions,
        "aggregate": aggregate(sessions),
        "delivery_manifests": delivery_data,
        "staleness": staleness_data,
    }

    if args.json:
        json.dump(report, sys.stdout, indent=2, default=str)
        print()
    else:
        print_summary(report)
        print_staleness_report(staleness_data)


if __name__ == "__main__":
    main()
