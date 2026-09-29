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

Usage:
  python3 scripts/analyze-memory-usage.py [--project <project-dir>] [--json] [--sessions N]

  --project   Claude project transcript directory
              (default: ~/.claude/projects/-Users-*-openrig/)
  --json      Output raw JSON report instead of human-readable summary
  --sessions  Limit to the N most recent sessions (default: all)
"""

import argparse
import glob
import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

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

    print("=" * 60)
    print("  Memory Surface Usage Report")
    print("=" * 60)
    print(f"  Project:    {meta['project']}")
    print(f"  Analyzed:   {meta['analyzed_at'][:19]}")
    print(f"  Sessions:   {agg['session_count']}")
    print()

    print("  Coverage")
    print("  " + "-" * 40)
    obs = agg["observation_coverage"]
    del_ = agg["delivery_coverage"]
    print(f"  Observation: {obs:.0%}  ({int(obs * agg['session_count'])}/{agg['session_count']} sessions touch memory)")
    print(f"  Delivery:    {del_:.0%}  ({int(del_ * agg['session_count'])}/{agg['session_count']} sessions receive startup delivery)")
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

    report = {
        "meta": {
            "project": os.path.basename(project_dir),
            "project_dir": project_dir,
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "transcript_count": len(jsonl_files),
        },
        "sessions": sessions,
        "aggregate": aggregate(sessions),
    }

    if args.json:
        json.dump(report, sys.stdout, indent=2, default=str)
        print()
    else:
        print_summary(report)


if __name__ == "__main__":
    main()
