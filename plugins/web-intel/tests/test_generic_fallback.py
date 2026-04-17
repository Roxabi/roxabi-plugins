"""Integration tests for the generic fetcher's fast → stealth → meta → error chain.

These tests mock ``safe_fetch`` and ``fetch_html_stealth`` at the
``scripts.fetchers.generic`` module namespace — we don't hit the real
network or launch a real browser. The goal is to exercise every branch of
the fallback chain and verify that errors propagate with the right context.

Regression coverage for commit 7f58dbd:
  - HTTP 5xx retry-exhausted MUST trigger the stealth retry (was silently
    skipped before because generic.py only read ``status_code`` from the
    success branch of ``safe_fetch``).
  - Stealth failures MUST surface a specific reason in the final error
    (was collapsed to a bare ``HTTP 403``).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import pytest

_plugin_root = str(Path(__file__).resolve().parents[1])
if _plugin_root not in sys.path:
    sys.path.insert(0, _plugin_root)

from scripts.fetchers import generic


# -----------------------------------------------------------------------------
# Helpers — mock factories
# -----------------------------------------------------------------------------


def _safe_fetch_ok(html: str) -> Dict[str, Any]:
    """Return a safe_fetch success payload with 200 + the given HTML."""
    return {
        "success": True,
        "status_code": 200,
        "content": html.encode("utf-8"),
    }


def _safe_fetch_status(status: int) -> Dict[str, Any]:
    """safe_fetch success=True payload with a non-200 status."""
    return {
        "success": True,
        "status_code": status,
        "content": b"",
    }


def _safe_fetch_retry_exhausted(status: int) -> Dict[str, Any]:
    """safe_fetch after retry exhaustion — success=False but status_code still exposed.

    This is the subtle shape that broke the original stealth trigger for 5xx.
    """
    return {
        "success": False,
        "status_code": status,
        "error": f"HTTP {status}",
    }


def _safe_fetch_dns_failure() -> Dict[str, Any]:
    """safe_fetch for a DNS lookup failure — no status_code at all."""
    return {
        "success": False,
        "status_code": None,
        "error": "Name or service not known",
    }


def _mock_safe_fetch(monkeypatch, payload: Dict[str, Any]) -> None:
    """Replace ``safe_fetch`` at the import site with a constant-returning stub."""
    monkeypatch.setattr(generic, "safe_fetch", lambda *a, **kw: payload)


def _mock_stealth(
    monkeypatch,
    *,
    html: Optional[str] = None,
    error: Optional[str] = None,
) -> list[str]:
    """Replace ``fetch_html_stealth`` with a stub returning ``(html, error)``.

    Returns a list that gets populated with every URL the stub was called
    with, so tests can assert whether stealth was invoked at all.
    """
    calls: list[str] = []

    def stub(url: str, *a: Any, **kw: Any) -> Tuple[Optional[str], Optional[str]]:
        calls.append(url)
        return html, error

    monkeypatch.setattr(generic, "fetch_html_stealth", stub)
    return calls


# -----------------------------------------------------------------------------
# Happy path
# -----------------------------------------------------------------------------


class TestFastPath:
    def test_200_with_extractable_body_succeeds(self, monkeypatch):
        _mock_safe_fetch(
            monkeypatch,
            _safe_fetch_ok(
                "<html><head><title>Hello</title></head>"
                "<body><article>" + ("This is a meaningful article body. " * 5)
                + "</article></body></html>"
            ),
        )
        calls = _mock_stealth(monkeypatch, html=None, error=None)

        r = generic.fetch_webpage_content("https://example.com")

        assert r["success"] is True, r.get("error")
        assert r.get("title") == "Hello"
        assert r.get("text_length", 0) >= 50
        assert calls == [], "stealth must NOT be invoked on a healthy 200"


# -----------------------------------------------------------------------------
# Anti-bot: every trigger path MUST invoke stealth and surface the outcome
# -----------------------------------------------------------------------------


class TestStealthTriggers:
    @pytest.mark.parametrize("status", [403, 429, 503])
    def test_anti_bot_status_triggers_stealth(self, monkeypatch, status):
        """403, 429, 503 — stealth must fire regardless of success flag."""
        _mock_safe_fetch(monkeypatch, _safe_fetch_status(status))
        calls = _mock_stealth(monkeypatch, html=None, error="playwright not installed")

        r = generic.fetch_webpage_content("https://blocked.example.com")

        assert calls == ["https://blocked.example.com"], (
            f"stealth must be called for HTTP {status}"
        )
        assert r["success"] is False
        assert f"HTTP {status}" in r["error"]
        assert "stealth retry failed: playwright not installed" in r["error"]

    @pytest.mark.parametrize("status", [403, 429, 503])
    def test_retry_exhausted_5xx_still_triggers_stealth(self, monkeypatch, status):
        """Regression: safe_fetch success=False + status_code=503 was missed.

        Before the fix in 7f58dbd, generic.py only read ``status_code`` from
        the ``result['success'] is True`` branch. Retry-exhausted 5xx
        responses set ``success=False`` but still expose ``status_code``,
        so stealth was silently skipped. This test pins the fix.
        """
        _mock_safe_fetch(monkeypatch, _safe_fetch_retry_exhausted(status))
        calls = _mock_stealth(monkeypatch, html=None, error="still blocked")

        r = generic.fetch_webpage_content("https://slow.example.com")

        assert calls == ["https://slow.example.com"], (
            f"retry-exhausted {status} must still trigger stealth"
        )
        assert r["success"] is False
        assert "stealth retry failed" in r["error"]


class TestStealthSkipped:
    def test_500_does_not_trigger_stealth(self, monkeypatch):
        """500 is a genuine server error, not bot protection — no retry."""
        _mock_safe_fetch(monkeypatch, _safe_fetch_status(500))
        calls = _mock_stealth(monkeypatch, html="<html/>", error=None)

        r = generic.fetch_webpage_content("https://broken.example.com")

        assert calls == [], "stealth must NOT fire for HTTP 500"
        assert r["success"] is False
        assert "500" in r["error"]

    def test_dns_failure_does_not_trigger_stealth(self, monkeypatch):
        """No status_code + fast_path_error → stealth has no signal to react to."""
        _mock_safe_fetch(monkeypatch, _safe_fetch_dns_failure())
        calls = _mock_stealth(monkeypatch, html="<html/>", error=None)

        r = generic.fetch_webpage_content("https://nonexistent.invalid")

        assert calls == [], "stealth must NOT fire on DNS failure"
        assert r["success"] is False
        assert "Name or service not known" in r["error"]


# -----------------------------------------------------------------------------
# Error composition — the user sees the full story, not just "HTTP 403"
# -----------------------------------------------------------------------------


class TestErrorComposition:
    def test_stealth_error_is_concatenated_to_fast_path_error(self, monkeypatch):
        _mock_safe_fetch(monkeypatch, _safe_fetch_status(403))
        _mock_stealth(monkeypatch, html=None, error="TimeoutError: navigation timeout")

        r = generic.fetch_webpage_content("https://blocked.example.com")

        assert r["success"] is False
        # Both the fast-path reason AND the stealth reason must be present
        assert "HTTP 403" in r["error"]
        assert "stealth retry failed" in r["error"]
        assert "TimeoutError" in r["error"]
        assert "·" in r["error"], "reasons should be joined with ' · '"

    def test_stealth_fetched_but_extraction_empty_notes_the_fact(self, monkeypatch):
        """Stealth succeeded at fetching but page had nothing extractable."""
        _mock_safe_fetch(monkeypatch, _safe_fetch_status(403))
        # Return a page whose body has < 50 chars of extractable text
        _mock_stealth(
            monkeypatch,
            html="<html><body><p>tiny</p></body></html>",
            error=None,
        )

        r = generic.fetch_webpage_content("https://blocked.example.com")

        assert r["success"] is False
        assert "HTTP 403" in r["error"]
        assert "stealth retry fetched the page but extracted only" in r["error"]


# -----------------------------------------------------------------------------
# Dependency guards
# -----------------------------------------------------------------------------


class TestDependencyGuards:
    def test_trafilatura_missing_returns_install_hint(self, monkeypatch):
        monkeypatch.setattr(generic, "TRAFILATURA_AVAILABLE", False)
        r = generic.fetch_webpage_content("https://example.com")
        assert r["success"] is False
        assert "trafilatura" in r["error"].lower()
        assert r.get("_do_not_cache") is True


# -----------------------------------------------------------------------------
# Meta-only fallback (SPA with rich Open Graph tags but empty body)
# -----------------------------------------------------------------------------


class TestMetaFallback:
    def test_empty_body_with_og_tags_synthesizes_from_metadata(self, monkeypatch):
        """SPA-style page: empty body, rich <meta> tags → return the metadata."""
        og_only_html = (
            "<html><head>"
            '<title>Product Page</title>'
            '<meta property="og:title" content="Amazing Product">'
            '<meta property="og:description" '
            'content="A very detailed product description that explains everything.">'
            "</head><body></body></html>"
        )
        _mock_safe_fetch(monkeypatch, _safe_fetch_ok(og_only_html))
        _mock_stealth(monkeypatch, html=None, error=None)

        r = generic.fetch_webpage_content("https://spa.example.com")

        assert r["success"] is True, r.get("error")
        assert r.get("_meta_fallback") is True
        # Synthesized text contains the title and description
        text = r.get("text", "")
        assert "Amazing Product" in text or "Product Page" in text
