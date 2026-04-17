"""Tests for scripts/screenshot.py — graceful degradation + error surfacing."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

_plugin_root = str(Path(__file__).resolve().parents[1])
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

from scripts import screenshot
from scripts.screenshot import capture_full_page


class TestCaptureFullPage:
    def test_playwright_missing_returns_install_hint(self, monkeypatch):
        # When Playwright isn't installed, the user must see an actionable
        # install command, not a generic "failed" message.
        monkeypatch.setattr(screenshot, "PLAYWRIGHT_AVAILABLE", False)
        success, msg = capture_full_page("https://example.com", "/tmp/x.png")
        assert success is False
        assert "playwright not installed" in msg.lower()
        assert "uv sync" in msg
        assert "playwright install chromium" in msg

    def test_ssrf_loopback_rejected(self):
        # Real SSRF validator call — rejects without launching browser
        success, msg = capture_full_page("http://127.0.0.1/", "/tmp/x.png")
        assert success is False
        assert "SSRF" in msg

    def test_ssrf_private_network_rejected(self):
        success, msg = capture_full_page("http://10.0.0.1/", "/tmp/x.png")
        assert success is False
        assert "SSRF" in msg

    def test_invalid_scheme_rejected(self):
        success, msg = capture_full_page("file:///etc/passwd", "/tmp/x.png")
        assert success is False
        assert "SSRF" in msg


class TestCLI:
    """CLI-level behavior — exit codes and stream routing."""

    @pytest.fixture
    def script_path(self):
        return str(Path(__file__).resolve().parents[1] / "scripts" / "screenshot.py")

    def test_no_args_exits_1_with_usage_on_stderr(self, script_path):
        r = subprocess.run(
            [sys.executable, script_path],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert r.returncode == 1
        assert "Usage" in r.stderr
        assert r.stdout == ""

    def test_one_arg_exits_1_with_usage_on_stderr(self, script_path):
        r = subprocess.run(
            [sys.executable, script_path, "https://example.com"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert r.returncode == 1
        assert "Usage" in r.stderr
