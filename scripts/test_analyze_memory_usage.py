"""Tests for analyze-memory-usage.py — RIG-36 item 1.

Covers: aggregate(), print_summary(), query_delivery_manifests(),
and the end-to-end parse → aggregate → report pipeline.
"""

import json
import os
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

# Import the module under test
import importlib.util
SCRIPT_PATH = Path(__file__).parent / "analyze-memory-usage.py"
spec = importlib.util.spec_from_file_location("analyze_memory", SCRIPT_PATH)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

aggregate = mod.aggregate
print_summary = mod.print_summary
query_delivery_manifests = mod.query_delivery_manifests
parse_session = mod.parse_session
MEMORY_SURFACES = mod.MEMORY_SURFACES


# -- Fixtures --

def make_session(session_id="s1", interactions=0, delivery=None, skills=None):
    """Build a minimal session dict matching parse_session output."""
    surface_stats = {}
    if interactions > 0:
        surface_stats["auto-memory"] = {
            "total": interactions,
            "reads": interactions,
            "writes": 0,
            "other": 0,
            "tools": {"Read": interactions},
            "tier": "T7-host-local",
        }
    return {
        "session_id": session_id,
        "file_size": 1024,
        "total_lines": 100,
        "total_tool_uses": 10,
        "first_timestamp": "2026-09-29T00:00:00Z",
        "last_timestamp": "2026-09-29T01:00:00Z",
        "memory_interactions": {
            "total": interactions,
            "by_surface": surface_stats,
        },
        "startup_delivery": delivery or {
            "wiki_delivered": False,
            "memory_delivered": False,
            "claude_md_delivered": False,
            "guidance_delivered": False,
        },
        "skill_invocations": skills or [],
        "memory_skill_invocations": [],
    }


def make_events_db(manifests=None, startups=0):
    """Create a temporary SQLite DB with an events table."""
    tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
    tmp.close()
    conn = sqlite3.connect(tmp.name)
    conn.execute(
        "CREATE TABLE events ("
        "  seq INTEGER PRIMARY KEY AUTOINCREMENT,"
        "  rig_id TEXT,"
        "  node_id TEXT,"
        "  type TEXT NOT NULL,"
        "  payload TEXT NOT NULL,"
        "  created_at TEXT NOT NULL DEFAULT (datetime('now'))"
        ")"
    )
    for _ in range(startups):
        conn.execute(
            "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)",
            ("r1", "n1", "node.startup_ready", "{}"),
        )
    for m in (manifests or []):
        conn.execute(
            "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)",
            ("r1", m.get("node_id", "n1"), "node.startup_delivery_manifest", json.dumps(m)),
        )
    conn.commit()
    conn.close()
    return tmp.name


def make_jsonl_transcript(entries):
    """Write a JSONL transcript file and return its path."""
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".jsonl", delete=False, dir=tempfile.gettempdir()
    )
    for entry in entries:
        tmp.write(json.dumps(entry) + "\n")
    tmp.close()
    return tmp.name


# -- aggregate() tests --

class TestAggregate:
    def test_empty_sessions_returns_empty_dict(self):
        assert aggregate([]) == {}

    def test_single_session_no_memory(self):
        result = aggregate([make_session()])
        assert result["session_count"] == 1
        assert result["observation_coverage"] == 0.0
        assert result["delivery_coverage"] == 0.0

    def test_single_session_with_memory(self):
        result = aggregate([make_session(interactions=5)])
        assert result["session_count"] == 1
        assert result["observation_coverage"] == 1.0
        assert "auto-memory" in result["surface_activity"]
        assert result["surface_activity"]["auto-memory"]["total_reads"] == 5

    def test_single_session_with_delivery(self):
        delivery = {
            "wiki_delivered": True,
            "memory_delivered": False,
            "claude_md_delivered": True,
            "guidance_delivered": False,
        }
        result = aggregate([make_session(delivery=delivery)])
        assert result["delivery_coverage"] == 1.0

    def test_multi_session_coverage_ratios(self):
        sessions = [
            make_session("s1", interactions=3),
            make_session("s2", interactions=0),
            make_session("s3", interactions=1),
        ]
        result = aggregate(sessions)
        assert result["session_count"] == 3
        assert result["observation_coverage"] == pytest.approx(0.667, abs=0.001)

    def test_read_write_ratio(self):
        session = make_session("s1")
        session["memory_interactions"]["total"] = 7
        session["memory_interactions"]["by_surface"]["wiki"] = {
            "total": 7,
            "reads": 5,
            "writes": 2,
            "other": 0,
            "tools": {"Read": 5, "Write": 2},
            "tier": "T4-project-evidence",
        }
        result = aggregate([session])
        assert result["surface_activity"]["wiki"]["read_write_ratio"] == 2.5


# -- print_summary() tests --

class TestPrintSummary:
    def test_empty_aggregate_prints_nothing_to_report(self, capsys):
        report = {
            "meta": {"project": "test", "analyzed_at": "2026-09-29T00:00:00Z"},
            "aggregate": {},
        }
        print_summary(report)
        captured = capsys.readouterr()
        assert "No sessions parsed" in captured.out

    def test_valid_report_prints_header(self, capsys):
        session = make_session(interactions=2)
        report = {
            "meta": {"project": "test-project", "analyzed_at": "2026-09-29T12:00:00Z"},
            "sessions": [session],
            "aggregate": aggregate([session]),
        }
        print_summary(report)
        captured = capsys.readouterr()
        assert "Memory Surface Usage Report" in captured.out
        assert "test-project" in captured.out


# -- query_delivery_manifests() tests --

class TestQueryDeliveryManifests:
    def test_missing_db_returns_unavailable(self):
        result = query_delivery_manifests("/nonexistent/path.sqlite")
        assert result["available"] is False
        assert "not found" in result["reason"]

    def test_empty_db_returns_zero_manifests(self):
        db_path = make_events_db(startups=3)
        try:
            result = query_delivery_manifests(db_path)
            assert result["available"] is True
            assert result["manifest_count"] == 0
            assert result["total_startups"] == 3
        finally:
            os.unlink(db_path)

    def test_single_manifest_parsed_correctly(self):
        manifest_payload = {
            "rigId": "r1",
            "nodeId": "n1",
            "sessionName": "dev-impl@test",
            "deliveredFiles": [
                {"path": "guidance/role.md", "deliveryHint": "guidance_merge", "surface": "guidance", "phase": "pre_launch", "contentHash": "abc123"},
                {"path": "skills/deploy/SKILL.md", "deliveryHint": "skill_install", "surface": "skill", "phase": "pre_launch", "contentHash": "def456"},
            ],
            "summary": {
                "preLaunchCount": 2,
                "postLaunchCount": 0,
                "surfaceCounts": {"guidance": 1, "skill": 1},
            },
        }
        db_path = make_events_db(manifests=[manifest_payload], startups=1)
        try:
            result = query_delivery_manifests(db_path)
            assert result["available"] is True
            assert result["manifest_count"] == 1
            assert result["delivery_rate"] == 1.0
            assert result["surface_totals"]["guidance"] == 1
            assert result["surface_totals"]["skill"] == 1
            assert result["manifests"][0]["file_count"] == 2
            assert result["manifests"][0]["session_name"] == "dev-impl@test"
        finally:
            os.unlink(db_path)

    def test_multiple_manifests_aggregate_surfaces(self):
        m1 = {
            "sessionName": "s1",
            "deliveredFiles": [{"path": "a", "surface": "guidance"}],
            "summary": {"surfaceCounts": {"guidance": 1}},
        }
        m2 = {
            "sessionName": "s2",
            "deliveredFiles": [{"path": "b", "surface": "guidance"}, {"path": "c", "surface": "wiki"}],
            "summary": {"surfaceCounts": {"guidance": 1, "wiki": 1}},
        }
        db_path = make_events_db(manifests=[m1, m2], startups=2)
        try:
            result = query_delivery_manifests(db_path)
            assert result["manifest_count"] == 2
            assert result["surface_totals"]["guidance"] == 2
            assert result["surface_totals"]["wiki"] == 1
        finally:
            os.unlink(db_path)

    def test_malformed_payload_skipped(self):
        db_path = make_events_db(startups=1)
        conn = sqlite3.connect(db_path)
        conn.execute(
            "INSERT INTO events (rig_id, node_id, type, payload) VALUES (?, ?, ?, ?)",
            ("r1", "n1", "node.startup_delivery_manifest", "not valid json{{{"),
        )
        conn.commit()
        conn.close()
        try:
            result = query_delivery_manifests(db_path)
            assert result["available"] is True
            assert result["manifest_count"] == 0
        finally:
            os.unlink(db_path)


# -- End-to-end: parse_session() --

class TestParseSession:
    def test_transcript_with_memory_read(self):
        entries = [
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "name": "Read",
                            "input": {"file_path": "/Users/test/.claude/projects/test/memory/feedback.md"},
                        }
                    ],
                    "usage": {"input_tokens": 100, "output_tokens": 50},
                },
                "timestamp": "2026-09-29T00:00:00Z",
            },
        ]
        path = make_jsonl_transcript(entries)
        try:
            result = parse_session(path)
            assert result["memory_interactions"]["total"] > 0
            assert "auto-memory" in result["memory_interactions"]["by_surface"]
        finally:
            os.unlink(path)

    def test_transcript_with_no_memory(self):
        entries = [
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "tool_use",
                            "name": "Read",
                            "input": {"file_path": "/tmp/some-code.ts"},
                        }
                    ],
                    "usage": {"input_tokens": 100, "output_tokens": 50},
                },
                "timestamp": "2026-09-29T00:00:00Z",
            },
        ]
        path = make_jsonl_transcript(entries)
        try:
            result = parse_session(path)
            assert result["memory_interactions"]["total"] == 0
        finally:
            os.unlink(path)

    def test_empty_transcript(self):
        path = make_jsonl_transcript([])
        try:
            result = parse_session(path)
            assert result["total_tool_uses"] == 0
            assert result["memory_interactions"]["total"] == 0
        finally:
            os.unlink(path)
