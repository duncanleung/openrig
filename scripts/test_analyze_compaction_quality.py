"""Tests for analyze-compaction-quality.py."""

import importlib
import json
import os
import sys
import tempfile
from pathlib import Path

import pytest

_mod = importlib.import_module("analyze-compaction-quality")

_extract_text = _mod._extract_text
_extract_tokens = _mod._extract_tokens
_extract_tool_uses = _mod._extract_tool_uses
_has_read_depth_audit = _mod._has_read_depth_audit
_is_restore_file = _mod._is_restore_file
_is_restore_phase = _mod._is_restore_phase
_short_path = _mod._short_path
_tool_file_path = _mod._tool_file_path
aggregate_sessions = _mod.aggregate_sessions
analyze_session = _mod.analyze_session
find_compaction_boundaries = _mod.find_compaction_boundaries
score_compaction = _mod.score_compaction


# -- Helper factories --

def make_user_record(text, ts=None):
    return {"type": "user", "timestamp": ts, "message": {"content": text}}


def make_assistant_record(text="", tool_uses=None, tokens=None):
    content = []
    if text:
        content.append({"type": "text", "text": text})
    for tu in (tool_uses or []):
        content.append({"type": "tool_use", **tu})
    usage = {}
    if tokens:
        usage = {"input_tokens": tokens.get("input", 0), "output_tokens": tokens.get("output", 0)}
    return {"type": "assistant", "message": {"content": content, "usage": usage}}


def make_tool_use(name="Read", file_path=None, command=None):
    inp = {}
    if file_path:
        inp["file_path"] = file_path
    if command:
        inp["command"] = command
    return {"name": name, "input": inp}


# -- _extract_text --

class TestExtractText:
    def test_string_content(self):
        record = {"message": {"content": "hello"}}
        assert _extract_text(record) == "hello"

    def test_list_content(self):
        record = {"message": {"content": [
            {"type": "text", "text": "part1"},
            {"type": "text", "text": "part2"},
        ]}}
        assert _extract_text(record) == "part1 part2"

    def test_empty(self):
        assert _extract_text({}) == ""
        assert _extract_text({"message": {}}) == ""


# -- _extract_tool_uses --

class TestExtractToolUses:
    def test_extracts_tool_use_blocks(self):
        record = {"message": {"content": [
            {"type": "text", "text": "reading file"},
            {"type": "tool_use", "name": "Read", "input": {"file_path": "/a.ts"}},
        ]}}
        tools = _extract_tool_uses(record)
        assert len(tools) == 1
        assert tools[0]["name"] == "Read"

    def test_no_tools(self):
        record = {"message": {"content": [{"type": "text", "text": "hello"}]}}
        assert _extract_tool_uses(record) == []


# -- _extract_tokens --

class TestExtractTokens:
    def test_sums_input_and_output(self):
        record = {"message": {"usage": {"input_tokens": 100, "output_tokens": 50}}}
        assert _extract_tokens(record) == 150

    def test_missing_usage(self):
        assert _extract_tokens({"message": {}}) == 0


# -- _tool_file_path --

class TestToolFilePath:
    def test_file_path_input(self):
        tool = {"input": {"file_path": "/src/main.ts"}}
        assert _tool_file_path(tool) == "/src/main.ts"

    def test_bash_command(self):
        tool = {"input": {"command": "cat /src/main.ts"}}
        assert _tool_file_path(tool) == "/src/main.ts"

    def test_no_path(self):
        tool = {"input": {"command": "ls -la"}}
        assert _tool_file_path(tool) is None


# -- _is_restore_file --

class TestIsRestoreFile:
    def test_restore_instruction(self):
        assert _is_restore_file("/tmp/restore-instructions.md")

    def test_restore_pending(self):
        assert _is_restore_file("~/.openrig/compaction/restore-pending/abc.json")

    def test_regular_file(self):
        assert not _is_restore_file("/src/domain/event-bus.ts")


# -- _is_restore_phase --

class TestIsRestorePhase:
    def test_restore_sentinel_text(self):
        assert _is_restore_phase([], "Restored from packet at ~/.openrig/...")

    def test_read_depth_text(self):
        assert _is_restore_phase([], "Read-Depth Audit complete")

    def test_restore_file_in_tools(self):
        tools = [{"input": {"file_path": "/tmp/restore-instructions.md"}}]
        assert _is_restore_phase(tools, "reading file")

    def test_normal_phase(self):
        tools = [{"input": {"file_path": "/src/main.ts"}}]
        assert not _is_restore_phase(tools, "implementing feature")


# -- _has_read_depth_audit --

class TestHasReadDepthAudit:
    def test_full_audit(self):
        text = "Read-Depth Audit:\n- /src/main.ts: FULL\n- /src/util.ts: NOT_READ"
        assert _has_read_depth_audit(text)

    def test_no_audit(self):
        assert not _has_read_depth_audit("Here is the implementation plan")

    def test_partial_match(self):
        text = "read depth analysis shows full and partial coverage"
        assert _has_read_depth_audit(text)


# -- _short_path --

class TestShortPath:
    def test_short_path_unchanged(self):
        assert _short_path("/src/main.ts") == "/src/main.ts"

    def test_long_path_shortened(self):
        long_path = "/very/long/path/to/some/deeply/nested/directory/with/extra/segments/file.ts"
        result = _short_path(long_path)
        assert result.startswith("…/")
        assert result.endswith("file.ts")


# -- find_compaction_boundaries --

class TestFindCompactionBoundaries:
    def test_no_compaction(self):
        records = [
            make_user_record("hello"),
            make_assistant_record("hi there"),
        ]
        assert find_compaction_boundaries(records) == []

    def test_single_compaction(self):
        records = [
            make_assistant_record(
                tool_uses=[make_tool_use(file_path="/src/a.ts")],
                tokens={"input": 1000, "output": 200},
            ),
            make_user_record("/compact"),
            make_assistant_record(
                text="Restored from packet",
                tool_uses=[make_tool_use(file_path="/tmp/restore-instructions.md")],
                tokens={"input": 500, "output": 100},
            ),
        ]
        result = find_compaction_boundaries(records)
        assert len(result) == 1
        assert "/src/a.ts" in result[0]["pre_files"]
        assert result[0]["restore_sentinel"] is not None

    def test_multiple_compactions(self):
        records = [
            make_assistant_record(tool_uses=[make_tool_use(file_path="/src/a.ts")]),
            make_user_record("/compact"),
            make_assistant_record(text="restored"),
            make_assistant_record(tool_uses=[make_tool_use(file_path="/src/b.ts")]),
            make_user_record("/compact"),
            make_assistant_record(text="restored from packet again"),
        ]
        result = find_compaction_boundaries(records)
        assert len(result) == 2

    def test_detects_read_depth_audit(self):
        records = [
            make_assistant_record(tool_uses=[make_tool_use(file_path="/src/a.ts")]),
            make_user_record("/compact"),
            make_assistant_record(
                text="Read-Depth Audit:\n- /src/a.ts: FULL\n- /src/b.ts: NOT_READ"
            ),
        ]
        result = find_compaction_boundaries(records)
        assert len(result) == 1
        assert result[0]["restore_audit_found"]


# -- score_compaction --

class TestScoreCompaction:
    def test_full_preservation(self):
        compaction = {
            "pre_files": {"/src/a.ts", "/src/b.ts"},
            "post_files_read": {"/src/a.ts", "/src/b.ts", "/src/c.ts"},
            "post_restore_files": set(),
            "restore_audit_found": True,
            "restore_sentinel": "Restored from packet",
            "pre_token_total": 5000,
            "post_token_total": 3000,
            "post_restore_tokens": 1000,
        }
        score = score_compaction(compaction)
        assert score["context_preservation"] == 1.0
        assert score["pre_file_count"] == 2
        assert score["post_file_count"] == 3
        assert score["recovered_file_count"] == 2
        assert score["missed_files"] == []
        assert score["read_depth_audit"]
        assert score["restore_sentinel"]

    def test_partial_preservation(self):
        compaction = {
            "pre_files": {"/src/a.ts", "/src/b.ts", "/src/c.ts", "/src/d.ts"},
            "post_files_read": {"/src/a.ts", "/src/b.ts"},
            "post_restore_files": set(),
            "restore_audit_found": False,
            "restore_sentinel": None,
            "pre_token_total": 5000,
            "post_token_total": 3000,
            "post_restore_tokens": 0,
        }
        score = score_compaction(compaction)
        assert score["context_preservation"] == 0.5
        assert score["recovered_file_count"] == 2
        assert len(score["missed_files"]) == 2
        assert not score["read_depth_audit"]
        assert not score["restore_sentinel"]

    def test_no_pre_files(self):
        compaction = {
            "pre_files": set(),
            "post_files_read": {"/src/a.ts"},
            "post_restore_files": set(),
            "restore_audit_found": False,
            "restore_sentinel": None,
            "pre_token_total": 0,
            "post_token_total": 1000,
            "post_restore_tokens": 0,
        }
        score = score_compaction(compaction)
        assert score["context_preservation"] is None

    def test_token_efficiency(self):
        compaction = {
            "pre_files": {"/src/a.ts"},
            "post_files_read": {"/src/a.ts"},
            "post_restore_files": set(),
            "restore_audit_found": False,
            "restore_sentinel": None,
            "pre_token_total": 10000,
            "post_token_total": 5000,
            "post_restore_tokens": 2500,
        }
        score = score_compaction(compaction)
        assert score["token_efficiency"]["restore_ratio"] == 0.5


# -- analyze_session --

class TestAnalyzeSession:
    def test_session_with_compaction(self, tmp_path):
        records = [
            make_assistant_record(
                tool_uses=[make_tool_use(file_path="/src/main.ts")],
                tokens={"input": 1000, "output": 200},
            ),
            make_user_record("/compact"),
            make_assistant_record(
                text="Restored from packet",
                tool_uses=[make_tool_use(file_path="/src/main.ts")],
                tokens={"input": 500, "output": 100},
            ),
        ]
        jsonl_path = tmp_path / "test-session.jsonl"
        with open(jsonl_path, "w") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

        result = analyze_session(str(jsonl_path))
        assert result["session_id"] == "test-session"
        assert result["compaction_count"] == 1
        assert result["compactions"][0]["context_preservation"] == 1.0

    def test_session_without_compaction(self, tmp_path):
        records = [
            make_user_record("hello"),
            make_assistant_record("hi there"),
        ]
        jsonl_path = tmp_path / "no-compact.jsonl"
        with open(jsonl_path, "w") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

        result = analyze_session(str(jsonl_path))
        assert result["compaction_count"] == 0

    def test_handles_malformed_json(self, tmp_path):
        jsonl_path = tmp_path / "bad.jsonl"
        with open(jsonl_path, "w") as f:
            f.write("not json\n")
            f.write(json.dumps(make_user_record("hello")) + "\n")

        result = analyze_session(str(jsonl_path))
        assert result["total_records"] == 1


# -- aggregate_sessions --

class TestAggregateSessions:
    def test_no_compactions(self):
        sessions = [{"session_id": "a", "compaction_count": 0, "compactions": []}]
        assert aggregate_sessions(sessions) == {}

    def test_aggregation(self):
        sessions = [
            {
                "session_id": "a",
                "compaction_count": 1,
                "compactions": [{
                    "context_preservation": 0.8,
                    "pre_file_count": 5,
                    "post_file_count": 6,
                    "recovered_file_count": 4,
                    "missed_files": ["/src/x.ts"],
                    "new_files": ["/src/y.ts", "/src/z.ts"],
                    "read_depth_audit": True,
                    "restore_sentinel": True,
                    "sentinel_text": "ok",
                    "restore_files_read": [],
                    "token_efficiency": {
                        "pre_compact_tokens": 10000,
                        "post_compact_tokens": 5000,
                        "restore_tokens": 1500,
                        "restore_ratio": 0.3,
                    },
                }],
            },
            {
                "session_id": "b",
                "compaction_count": 1,
                "compactions": [{
                    "context_preservation": 0.6,
                    "pre_file_count": 10,
                    "post_file_count": 8,
                    "recovered_file_count": 6,
                    "missed_files": ["/src/a.ts", "/src/b.ts", "/src/c.ts", "/src/d.ts"],
                    "new_files": [],
                    "read_depth_audit": False,
                    "restore_sentinel": False,
                    "sentinel_text": None,
                    "restore_files_read": [],
                    "token_efficiency": {
                        "pre_compact_tokens": 8000,
                        "post_compact_tokens": 4000,
                        "restore_tokens": 2000,
                        "restore_ratio": 0.5,
                    },
                }],
            },
        ]
        agg = aggregate_sessions(sessions)
        assert agg["session_count"] == 2
        assert agg["sessions_with_compaction"] == 2
        assert agg["total_compactions"] == 2
        assert agg["avg_context_preservation"] == 0.7
        assert agg["min_context_preservation"] == 0.6
        assert agg["max_context_preservation"] == 0.8
        assert agg["read_depth_audit_rate"] == 0.5
        assert agg["restore_sentinel_rate"] == 0.5
        assert agg["total_files_missed"] == 5
        assert agg["global_recovery_rate"] == round(10 / 15, 3)


# -- Integration test --

class TestIntegration:
    def test_full_pipeline(self, tmp_path):
        """End-to-end: write a transcript, analyze it, verify the report."""
        records = [
            # Pre-compact work
            make_assistant_record(
                tool_uses=[
                    make_tool_use(file_path="/src/domain/event-bus.ts"),
                    make_tool_use(file_path="/src/domain/types.ts"),
                    make_tool_use(file_path="/src/domain/rig-repository.ts"),
                ],
                tokens={"input": 5000, "output": 1000},
            ),
            make_assistant_record(
                text="implementing the feature",
                tool_uses=[make_tool_use(file_path="/src/domain/startup-orchestrator.ts")],
                tokens={"input": 3000, "output": 800},
            ),
            # Compaction
            make_user_record("/compact"),
            # Post-compact restore
            make_assistant_record(
                text="Restored from packet at ~/.openrig/compaction/restore-pending/abc.json",
                tool_uses=[
                    make_tool_use(file_path="/tmp/restore-instructions.md"),
                    make_tool_use(file_path="/src/domain/event-bus.ts"),
                    make_tool_use(file_path="/src/domain/types.ts"),
                ],
                tokens={"input": 2000, "output": 500},
            ),
            make_assistant_record(
                text="Read-Depth Audit:\n- event-bus.ts: FULL\n- types.ts: FULL\n- startup-orchestrator.ts: NOT_READ",
                tokens={"input": 500, "output": 200},
            ),
            # Resumed work
            make_assistant_record(
                text="continuing implementation",
                tool_uses=[make_tool_use(file_path="/src/domain/startup-orchestrator.ts")],
                tokens={"input": 4000, "output": 1000},
            ),
        ]

        jsonl_path = tmp_path / "integration.jsonl"
        with open(jsonl_path, "w") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")

        result = analyze_session(str(jsonl_path))

        assert result["compaction_count"] == 1
        c = result["compactions"][0]

        # 4 unique pre-compact files
        assert c["pre_file_count"] == 4

        # 3 post-compact files read (restore-instructions.md, event-bus.ts, types.ts)
        # plus startup-orchestrator.ts in the resumed work
        assert c["post_file_count"] >= 3

        # Should have found the read-depth audit
        assert c["read_depth_audit"]

        # Should have found the restore sentinel
        assert c["restore_sentinel"]

        # Restore files read
        assert any("restore-instructions" in f for f in c["restore_files_read"])
