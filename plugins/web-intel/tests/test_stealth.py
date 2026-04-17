"""Tests for fetchers/stealth.py — anti-bot signature detection + tuple contract."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

_plugin_root = str(Path(__file__).resolve().parents[1])
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

# Importing the module adds its own sibling paths for _shared
from scripts.fetchers import stealth
from scripts.fetchers.stealth import (
    ANTIBOT_STATUS_CODES,
    CF_CHALLENGE_MARKERS,
    fetch_html_stealth,
    has_antibot_signature,
)


# -----------------------------------------------------------------------------
# has_antibot_signature — pure logic, no network
# -----------------------------------------------------------------------------


class TestAntibotSignature:
    def test_status_403_triggers(self):
        assert has_antibot_signature(status_code=403) is True

    def test_status_429_triggers(self):
        assert has_antibot_signature(status_code=429) is True

    def test_status_503_triggers(self):
        # Regression: this path was silently skipped before fa46b9b's fix
        # because generic.py only read status_code when safe_fetch reported
        # success=True, but safe_fetch exposes it on retry-exhausted 5xx too.
        assert has_antibot_signature(status_code=503) is True

    def test_status_200_does_not_trigger(self):
        assert has_antibot_signature(status_code=200) is False

    def test_status_500_does_not_trigger(self):
        # 500 is a genuine server error, not bot protection — leave it alone
        assert has_antibot_signature(status_code=500) is False

    def test_status_404_does_not_trigger(self):
        assert has_antibot_signature(status_code=404) is False

    def test_none_status_does_not_trigger(self):
        assert has_antibot_signature() is False

    @pytest.mark.parametrize("marker", list(CF_CHALLENGE_MARKERS))
    def test_every_cf_marker_triggers(self, marker):
        html = f"<html><body>{marker}</body></html>"
        assert has_antibot_signature(html=html) is True

    def test_benign_html_does_not_trigger(self):
        html = "<html><body>Hello world, this is a normal page.</body></html>"
        # 200 status + >= 50 chars of extracted text → no retry
        assert has_antibot_signature(status_code=200, html=html, text_length=200) is False

    def test_short_text_length_triggers(self):
        # Page rendered nothing useful — try stealth
        assert has_antibot_signature(status_code=200, html="<html/>", text_length=10) is True

    def test_text_length_at_minimum_does_not_trigger(self):
        # Exactly 50 chars is the boundary — must NOT trigger
        assert has_antibot_signature(status_code=200, html="<html/>", text_length=50) is False

    def test_antibot_set_is_frozen(self):
        # Frozenset guards against accidental mutation at runtime
        assert isinstance(ANTIBOT_STATUS_CODES, frozenset)
        assert ANTIBOT_STATUS_CODES == frozenset({403, 429, 503})


# -----------------------------------------------------------------------------
# fetch_html_stealth — tuple return contract
# -----------------------------------------------------------------------------


class TestStealthTupleContract:
    def test_ssrf_loopback_returns_tuple_with_error(self):
        html, err = fetch_html_stealth("http://127.0.0.1/admin")
        assert html is None
        assert err is not None
        assert "SSRF" in err

    def test_ssrf_private_network_returns_tuple_with_error(self):
        html, err = fetch_html_stealth("http://192.168.1.1/")
        assert html is None
        assert err is not None

    def test_invalid_scheme_returns_tuple_with_error(self):
        html, err = fetch_html_stealth("file:///etc/passwd")
        assert html is None
        assert err is not None

    def test_playwright_missing_surfaces_install_hint(self, monkeypatch):
        # Simulate Playwright being absent — user should see an actionable
        # error, not a silent None (this was a silent-error finding fixed
        # in commit 7f58dbd).
        monkeypatch.setattr(stealth, "PLAYWRIGHT_AVAILABLE", False)
        html, err = fetch_html_stealth("https://example.com")
        assert html is None
        assert err is not None
        assert "playwright not installed" in err.lower()
        assert "uv sync" in err  # Install command is surfaced to the user


# -----------------------------------------------------------------------------
# Smoke: module-level constants are sensible
# -----------------------------------------------------------------------------


def test_cf_markers_are_non_empty_tuple():
    assert isinstance(CF_CHALLENGE_MARKERS, tuple)
    assert len(CF_CHALLENGE_MARKERS) >= 5
    assert all(isinstance(m, str) and m for m in CF_CHALLENGE_MARKERS)
