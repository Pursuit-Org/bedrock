"""Unit tests for pebble.formatting helpers."""

import pytest

from pebble.formatting import escape_md_table_cell, normalize_confidence, truncate_for_cell


class TestEscapeMdTableCell:
    def test_pipe_is_escaped(self):
        assert escape_md_table_cell("a|b") == "a\\|b"

    def test_newlines_become_spaces(self):
        assert escape_md_table_cell("line1\nline2\r\nline3") == "line1 line2  line3"

    def test_backslash_is_doubled_before_pipe_escape(self):
        # Without doubling, a literal backslash before a pipe could be
        # interpreted as the table-cell escape itself.
        assert escape_md_table_cell("a\\b|c") == "a\\\\b\\|c"

    def test_empty_string_passthrough(self):
        assert escape_md_table_cell("") == ""


class TestTruncateForCell:
    def test_returns_unchanged_below_limit(self):
        text, truncated = truncate_for_cell("short", 240)
        assert text == "short"
        assert truncated is False

    def test_truncates_above_limit_with_ellipsis(self):
        text, truncated = truncate_for_cell("a" * 300, 240)
        assert truncated is True
        assert text.endswith("…")
        assert len(text) == 240

    def test_at_limit_not_truncated(self):
        text, truncated = truncate_for_cell("x" * 240, 240)
        assert truncated is False
        assert text == "x" * 240

    def test_one_over_limit_truncated(self):
        text, truncated = truncate_for_cell("x" * 241, 240)
        assert truncated is True
        assert len(text) == 240


class TestNormalizeConfidence:
    @pytest.mark.parametrize(
        "value,expected",
        [
            (0.84, "High (0.84)"),
            (0.70, "High (0.70)"),
            (0.62, "Medium (0.62)"),
            (0.40, "Medium (0.40)"),
            (0.21, "Low (0.21)"),
            (0.0, "Low (0.00)"),
            (1.0, "High (1.00)"),
            ("high", "High"),
            ("MEDIUM", "Medium"),
            (" low ", "Low"),
            (None, "Unknown"),
            ("", "Unknown"),
            ("unknown", "Unknown"),
            ("garbage", "Unknown"),
            (1.5, "Unknown"),
            (-0.1, "Unknown"),
            (True, "Unknown"),
            (False, "Unknown"),
        ],
    )
    def test_normalization(self, value, expected):
        assert normalize_confidence(value) == expected
