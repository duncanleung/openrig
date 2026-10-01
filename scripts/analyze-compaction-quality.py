#!/usr/bin/env python3
"""Compaction quality analyzer.

Parses Claude JSONL transcripts to evaluate the quality of OpenRig's
precompact/postcompact cycle. Measures context preservation, read-depth
compliance, continuity, and token efficiency across compaction events.

Signals measured:
  - context_preservation: % of pre-compact active files recovered post-compact
  - read_depth_compliance: did the agent produce a read-depth audit table?
  - continuity_score: did the agent resume the correct task?
  - token_efficiency: % of post-compact tokens spent on restoration
  - compaction_count: total compactions in the session

Usage:
  python3 scripts/analyze-compaction-quality.py [--project <dir>] [--sessions N] [--json]
"""

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def find_compaction_boundaries(records):
    """Find compaction boundaries in a transcript.

    A compaction boundary is identified by:
    1. A /compact command (user message containing '/compact')
    2. A context summary (the compaction summary injected after /compact)
    3. Post-compact restore activity (tool_use events reading restore files)

    Returns a list of compaction events with pre/post metadata.
    """
    compactions = []
    current = None

    for idx, record in enumerate(records):
        record_type = record.get("type", "")
        ts = record.get("timestamp")

        # Detect compaction boundary:
        # 1. "/compact" command (manual compaction)
        # 2. "This session is being continued" (auto-compaction continuation)
        if record_type == "user":
            content = _extract_text(record)
            is_compact = "/compact" in content
            is_continuation = "this session is being continued" in content.lower()

            if is_compact or is_continuation:
                if current and current["phase"] == "pre":
                    current["compact_idx"] = idx
                    current["compact_ts"] = ts
                    current["phase"] = "post"
                    current["compact_type"] = "continuation" if is_continuation else "manual"
                else:
                    current = {
                        "compact_idx": idx,
                        "compact_ts": ts,
                        "compact_type": "continuation" if is_continuation else "manual",
                        "phase": "post",
                        "pre_files": set(),
                        "pre_tools": [],
                        "post_files_read": set(),
                        "post_tools": [],
                        "post_restore_files": set(),
                        "restore_audit_found": False,
                        "restore_sentinel": None,
                        "pre_token_total": 0,
                        "post_token_total": 0,
                        "post_restore_tokens": 0,
                    }
                    compactions.append(current)
                continue

        # Collect pre-compact file activity
        if record_type == "assistant" and (not current or current["phase"] == "pre"):
            if current is None:
                current = {
                    "phase": "pre",
                    "pre_files": set(),
                    "pre_tools": [],
                    "post_files_read": set(),
                    "post_tools": [],
                    "post_restore_files": set(),
                    "restore_audit_found": False,
                    "restore_sentinel": None,
                    "pre_token_total": 0,
                    "post_token_total": 0,
                    "post_restore_tokens": 0,
                }
                compactions.append(current)

            tools = _extract_tool_uses(record)
            for tool in tools:
                current["pre_tools"].append(tool)
                fp = _tool_file_path(tool)
                if fp:
                    current["pre_files"].add(fp)

            tokens = _extract_tokens(record)
            current["pre_token_total"] += tokens

        # Collect post-compact activity
        if record_type == "assistant" and current and current["phase"] == "post":
            tools = _extract_tool_uses(record)
            for tool in tools:
                current["post_tools"].append(tool)
                fp = _tool_file_path(tool)
                if fp:
                    current["post_files_read"].add(fp)
                    if _is_restore_file(fp):
                        current["post_restore_files"].add(fp)

            # Check for restore sentinel
            text = _extract_text(record)
            text_lower = text.lower()
            if ("restored from packet" in text_lower
                or "restore packet" in text_lower
                or "resuming" in text_lower
                or "picking up" in text_lower
                or "continuing" in text_lower):
                if current["restore_sentinel"] is None:
                    current["restore_sentinel"] = text[:200]

            # Check for read-depth audit
            if _has_read_depth_audit(text):
                current["restore_audit_found"] = True

            tokens = _extract_tokens(record)
            current["post_token_total"] += tokens
            if _is_restore_phase(tools, text):
                current["post_restore_tokens"] += tokens

    # Filter out pre-only (no compaction happened)
    return [c for c in compactions if "compact_idx" in c]


def score_compaction(compaction):
    """Score a single compaction event."""
    pre_files = compaction["pre_files"]
    post_files = compaction["post_files_read"]

    # Context preservation: what % of pre-compact files were read post-compact
    if pre_files:
        recovered = pre_files & post_files
        preservation = len(recovered) / len(pre_files)
    else:
        preservation = None  # Not measurable — no pre-compact file activity

    # Read-depth compliance
    audit_found = compaction["restore_audit_found"]

    # Continuity: did the agent emit the restore sentinel?
    has_sentinel = compaction["restore_sentinel"] is not None

    # Token efficiency: what % of post-compact tokens went to restoration
    post_total = compaction["post_token_total"]
    restore_tokens = compaction["post_restore_tokens"]
    if post_total > 0:
        restore_ratio = restore_tokens / post_total
    else:
        restore_ratio = 0.0

    return {
        "compact_type": compaction.get("compact_type", "unknown"),
        "context_preservation": round(preservation, 3) if preservation is not None else None,
        "pre_file_count": len(pre_files),
        "post_file_count": len(post_files),
        "recovered_file_count": len(pre_files & post_files) if pre_files else 0,
        "missed_files": sorted(pre_files - post_files) if pre_files else [],
        "new_files": sorted(post_files - pre_files) if pre_files else [],
        "read_depth_audit": audit_found,
        "restore_sentinel": has_sentinel,
        "sentinel_text": compaction["restore_sentinel"],
        "restore_files_read": sorted(compaction["post_restore_files"]),
        "token_efficiency": {
            "pre_compact_tokens": compaction["pre_token_total"],
            "post_compact_tokens": post_total,
            "restore_tokens": restore_tokens,
            "restore_ratio": round(restore_ratio, 3),
        },
    }


def analyze_session(jsonl_path):
    """Analyze one transcript for compaction quality."""
    session_id = Path(jsonl_path).stem
    file_size = os.path.getsize(jsonl_path)
    records = []

    with open(jsonl_path, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    compactions = find_compaction_boundaries(records)
    scored = [score_compaction(c) for c in compactions]

    return {
        "session_id": session_id,
        "file_size": file_size,
        "total_records": len(records),
        "compaction_count": len(compactions),
        "compactions": scored,
    }


def aggregate_sessions(sessions):
    """Compute cross-session compaction metrics."""
    sessions_with_compaction = [s for s in sessions if s["compaction_count"] > 0]
    if not sessions_with_compaction:
        return {}

    all_scores = []
    for s in sessions_with_compaction:
        all_scores.extend(s["compactions"])

    if not all_scores:
        return {}

    preservations = [s["context_preservation"] for s in all_scores
                     if s["context_preservation"] is not None]
    if not preservations:
        preservations = [0.0]
    audit_rate = sum(1 for s in all_scores if s["read_depth_audit"]) / len(all_scores)
    sentinel_rate = sum(1 for s in all_scores if s["restore_sentinel"]) / len(all_scores)
    restore_ratios = [s["token_efficiency"]["restore_ratio"] for s in all_scores]

    total_missed = sum(len(s["missed_files"]) for s in all_scores)
    total_recovered = sum(s["recovered_file_count"] for s in all_scores)
    total_pre = sum(s["pre_file_count"] for s in all_scores)

    return {
        "session_count": len(sessions),
        "sessions_with_compaction": len(sessions_with_compaction),
        "total_compactions": len(all_scores),
        "avg_context_preservation": round(sum(preservations) / len(preservations), 3),
        "min_context_preservation": round(min(preservations), 3),
        "max_context_preservation": round(max(preservations), 3),
        "read_depth_audit_rate": round(audit_rate, 3),
        "restore_sentinel_rate": round(sentinel_rate, 3),
        "avg_restore_token_ratio": round(sum(restore_ratios) / len(restore_ratios), 3),
        "total_files_missed": total_missed,
        "total_files_recovered": total_recovered,
        "total_pre_compact_files": total_pre,
        "global_recovery_rate": round(total_recovered / max(total_pre, 1), 3),
    }


def print_report(report):
    """Print human-readable compaction quality report."""
    agg = report["aggregate"]
    if not agg:
        print("No compaction events found in analyzed sessions.")
        return

    print("=" * 60)
    print("  Compaction Quality Report")
    print("=" * 60)
    print(f"  Project:    {report['meta']['project']}")
    print(f"  Analyzed:   {report['meta']['analyzed_at'][:19]}")
    print(f"  Sessions:   {agg['session_count']} total, "
          f"{agg['sessions_with_compaction']} with compaction")
    print(f"  Compaction events: {agg['total_compactions']}")
    print()

    print("  Context Preservation")
    print("  " + "-" * 50)
    print(f"  Average:  {agg['avg_context_preservation']:.0%}")
    print(f"  Range:    {agg['min_context_preservation']:.0%} – "
          f"{agg['max_context_preservation']:.0%}")
    print(f"  Files:    {agg['total_files_recovered']}/{agg['total_pre_compact_files']} "
          f"recovered ({agg['global_recovery_rate']:.0%})")
    print(f"  Missed:   {agg['total_files_missed']} files not re-read post-compact")
    print()

    print("  Compliance")
    print("  " + "-" * 50)
    print(f"  Read-depth audit: {agg['read_depth_audit_rate']:.0%} of compactions")
    print(f"  Restore sentinel: {agg['restore_sentinel_rate']:.0%} of compactions")
    print()

    print("  Token Efficiency")
    print("  " + "-" * 50)
    print(f"  Avg restore ratio: {agg['avg_restore_token_ratio']:.0%} of post-compact "
          f"tokens spent on restoration")
    print()

    # Per-session detail
    sessions_with = [s for s in report["sessions"] if s["compaction_count"] > 0]
    if sessions_with:
        print("  Per-Session Detail")
        print("  " + "-" * 50)
        for s in sorted(sessions_with, key=lambda x: -x["compaction_count"])[:5]:
            print(f"  {s['session_id'][:12]}…  {s['compaction_count']} compaction(s)")
            for i, c in enumerate(s["compactions"]):
                pres = c["context_preservation"]
                if pres is None:
                    status = "·"
                elif pres >= 0.7:
                    status = "✓"
                else:
                    status = "⚠"
                audit = "audit" if c["read_depth_audit"] else "no-audit"
                sentinel = "sentinel" if c["restore_sentinel"] else "no-sentinel"
                ctype = c.get("compact_type", "?")
                pres_str = f"{pres:.0%}" if pres is not None else "n/a"
                print(f"    [{i+1}] {status} {ctype} preservation={pres_str} "
                      f"{audit} {sentinel} "
                      f"pre={c['pre_file_count']} post={c['post_file_count']} "
                      f"missed={len(c['missed_files'])}")
                if c["missed_files"]:
                    for mf in c["missed_files"][:3]:
                        print(f"        missed: {_short_path(mf)}")
        print()


# -- Helpers --

def _extract_text(record):
    """Extract text content from a record."""
    msg = record.get("message", {})
    content = msg.get("content", "")
    if isinstance(content, list):
        parts = []
        for p in content:
            if isinstance(p, dict):
                parts.append(p.get("text", ""))
            elif isinstance(p, str):
                parts.append(p)
        return " ".join(parts)
    return str(content) if content else ""


def _extract_tool_uses(record):
    """Extract tool_use entries from an assistant record."""
    msg = record.get("message", {})
    content = msg.get("content", [])
    if not isinstance(content, list):
        return []
    return [
        p for p in content
        if isinstance(p, dict) and p.get("type") == "tool_use"
    ]


def _extract_tokens(record):
    """Extract token count from a record's usage field."""
    msg = record.get("message", {})
    usage = msg.get("usage", {})
    return (usage.get("input_tokens", 0) + usage.get("output_tokens", 0))


def _tool_file_path(tool):
    """Extract file path from a tool_use entry."""
    inp = tool.get("input", {})
    if not isinstance(inp, dict):
        return None
    fp = inp.get("file_path", "")
    if fp:
        return fp
    cmd = inp.get("command", "")
    if isinstance(cmd, str):
        # Extract file paths from bash commands (Read-like patterns)
        # Exclude flags like -n, -15, etc.
        match = re.search(r'(?:cat|head|tail|less)\s+(?:-\S+\s+)*["\']?(/[^\s"\'|;]+)', cmd)
        if match:
            return match.group(1)
    return None


def _is_restore_file(filepath):
    """Check if a file is part of the restore packet."""
    restore_patterns = [
        "restore-instructions.md",
        "touched-files.md",
        "restore-pending",
        "restore-packet",
        "restore_packet",
        "claude-compaction-restore",
        "restore-map",
        "mental-model",
    ]
    fp_lower = filepath.lower()
    return any(p in fp_lower for p in restore_patterns)


def _is_restore_phase(tools, text):
    """Heuristic: are we still in the restore phase of post-compact?"""
    text_lower = text.lower()
    if "restored from packet" in text_lower:
        return True
    if "read-depth" in text_lower or "read depth" in text_lower:
        return True
    for tool in tools:
        fp = _tool_file_path(tool)
        if fp and _is_restore_file(fp):
            return True
    return False


def _has_read_depth_audit(text):
    """Check if text contains a read-depth audit table."""
    text_lower = text.lower()
    if "read-depth" not in text_lower and "read depth" not in text_lower:
        return False
    # Look for table-like patterns (FULL/PARTIAL/NOT_READ markers)
    audit_markers = ["full", "partial", "not_read", "not read"]
    marker_count = sum(1 for m in audit_markers if m in text_lower)
    return marker_count >= 2


def _short_path(filepath):
    """Shorten a file path for display."""
    if len(filepath) <= 60:
        return filepath
    parts = filepath.split("/")
    if len(parts) <= 3:
        return filepath
    return f"…/{'/'.join(parts[-3:])}"


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
    parser = argparse.ArgumentParser(
        description="Analyze compaction quality in Claude transcripts"
    )
    parser.add_argument("--project", help="Claude project transcript directory")
    parser.add_argument("--json", action="store_true", help="Output raw JSON")
    parser.add_argument("--sessions", type=int, default=0,
                        help="Limit to N most recent sessions (0=all)")
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
        jsonl_files = jsonl_files[:args.sessions]

    sessions = []
    for f in jsonl_files:
        try:
            sessions.append(analyze_session(f))
        except Exception as e:
            print(f"  skip {os.path.basename(f)}: {e}", file=sys.stderr)

    report = {
        "meta": {
            "project": os.path.basename(project_dir),
            "analyzed_at": datetime.now(timezone.utc).isoformat(),
            "transcript_count": len(jsonl_files),
        },
        "sessions": sessions,
        "aggregate": aggregate_sessions(sessions),
    }

    if args.json:
        json.dump(report, sys.stdout, indent=2, default=str)
        print()
    else:
        print_report(report)


if __name__ == "__main__":
    main()
