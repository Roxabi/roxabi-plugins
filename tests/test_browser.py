"""Tests for roxabi_sdk.browser — mock-based, no live Playwright.

These tests verify the SDK launcher contract from issue #93 without
requiring playwright or playwright-stealth to be installed at test time.
The lazy imports inside ``launch_stealth_*`` are intercepted by injecting
fake modules into ``sys.modules`` before the call.
"""
from __future__ import annotations

import sys
import types
from unittest.mock import AsyncMock, MagicMock

import pytest

from roxabi_sdk import browser
from roxabi_sdk.browser import (
    PlaywrightNotAvailableError,
    close_stealth,
    close_stealth_async,
    launch_stealth_sync,
)


# ---------------------------------------------------------------------------
# 1. Missing-playwright path
# ---------------------------------------------------------------------------


def test_missing_playwright_raises_typed_error(monkeypatch):
    """When the import probe trips, the typed error must surface verbatim."""

    def boom() -> None:
        raise PlaywrightNotAvailableError(browser._INSTALL_HINT)

    monkeypatch.setattr(browser, "_raise_if_unavailable", boom)

    with pytest.raises(PlaywrightNotAvailableError) as excinfo:
        launch_stealth_sync()

    msg = str(excinfo.value).lower()
    assert "playwright" in msg
    assert "uv sync" in msg or "pip install" in msg


# ---------------------------------------------------------------------------
# 2-3. Sync close paths
# ---------------------------------------------------------------------------


def test_close_stealth_ephemeral_closes_browser():
    """Ephemeral: ``context.browser`` is truthy → close the browser."""
    pw = MagicMock(name="playwright")
    ctx = MagicMock(name="context")
    ctx.browser = MagicMock(name="browser")  # truthy → ephemeral

    close_stealth(pw, ctx)

    ctx.browser.close.assert_called_once()
    ctx.close.assert_not_called()
    pw.stop.assert_called_once()


def test_close_stealth_persistent_closes_context():
    """Persistent: ``context.browser`` is ``None`` → close the context."""
    pw = MagicMock(name="playwright")
    ctx = MagicMock(name="context")
    ctx.browser = None  # persistent

    close_stealth(pw, ctx)

    ctx.close.assert_called_once()
    pw.stop.assert_called_once()


def test_close_stealth_persistent_still_stops_when_close_raises():
    """``finally`` must run ``playwright.stop()`` even if close raises."""
    pw = MagicMock(name="playwright")
    ctx = MagicMock(name="context")
    ctx.browser = None
    ctx.close.side_effect = RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        close_stealth(pw, ctx)

    pw.stop.assert_called_once()


# ---------------------------------------------------------------------------
# 4-5. Async close paths
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_close_stealth_async_ephemeral_awaits_close():
    pw = MagicMock(name="playwright")
    pw.stop = AsyncMock()
    ctx = MagicMock(name="context")
    ctx.browser = MagicMock(name="browser")
    ctx.browser.close = AsyncMock()
    ctx.close = AsyncMock()

    await close_stealth_async(pw, ctx)

    ctx.browser.close.assert_awaited_once()
    ctx.close.assert_not_awaited()
    pw.stop.assert_awaited_once()


@pytest.mark.asyncio
async def test_close_stealth_async_persistent_awaits_close():
    pw = MagicMock(name="playwright")
    pw.stop = AsyncMock()
    ctx = MagicMock(name="context")
    ctx.browser = None
    ctx.close = AsyncMock()

    await close_stealth_async(pw, ctx)

    ctx.close.assert_awaited_once()
    pw.stop.assert_awaited_once()


# ---------------------------------------------------------------------------
# 6. Default launch kwargs
# ---------------------------------------------------------------------------


def _install_fake_playwright(monkeypatch) -> tuple[MagicMock, MagicMock, MagicMock, MagicMock, MagicMock, MagicMock]:
    """Inject minimal fake ``playwright.sync_api`` and ``playwright_stealth``.

    Returns ``(launch_mock, new_context_mock, stealth_cls)`` so the test
    can inspect what the launcher passed downstream.
    """
    fake_page = MagicMock(name="page")
    fake_context = MagicMock(name="context")
    fake_context.pages = []
    fake_context.new_page.return_value = fake_page

    fake_browser = MagicMock(name="browser")
    fake_browser.new_context = MagicMock(return_value=fake_context)

    fake_chromium = MagicMock(name="chromium")
    fake_chromium.launch = MagicMock(return_value=fake_browser)

    fake_pw = MagicMock(name="playwright")
    fake_pw.chromium = fake_chromium

    fake_factory = MagicMock(name="sync_playwright_factory")
    fake_factory.start.return_value = fake_pw

    fake_sync_playwright = MagicMock(name="sync_playwright", return_value=fake_factory)

    sync_api_mod = types.ModuleType("playwright.sync_api")
    sync_api_mod.sync_playwright = fake_sync_playwright

    pw_root = types.ModuleType("playwright")
    pw_root.sync_api = sync_api_mod

    fake_stealth_cls = MagicMock(name="StealthClass")
    fake_stealth_instance = MagicMock(name="StealthInstance")
    fake_stealth_cls.return_value = fake_stealth_instance

    stealth_mod = types.ModuleType("playwright_stealth")
    stealth_mod.Stealth = fake_stealth_cls

    monkeypatch.setitem(sys.modules, "playwright", pw_root)
    monkeypatch.setitem(sys.modules, "playwright.sync_api", sync_api_mod)
    monkeypatch.setitem(sys.modules, "playwright_stealth", stealth_mod)

    # _raise_if_unavailable performs its own real imports of playwright /
    # playwright_stealth — those will succeed against the fakes above. Belt
    # and braces: short-circuit it so the test never depends on import resolution.
    monkeypatch.setattr(browser, "_raise_if_unavailable", lambda: None)

    return (
        fake_chromium.launch,
        fake_browser.new_context,
        fake_stealth_cls,
        fake_pw,
        fake_context,
        fake_page,
    )


def test_launch_kwargs_defaults_applied(monkeypatch):
    """Default launch must pass the 3 anti-detection args + UA / viewport / locale."""
    launch_mock, new_context_mock, stealth_cls, fake_pw, fake_context, fake_page = (
        _install_fake_playwright(monkeypatch)
    )

    pw, ctx, page = launch_stealth_sync()

    # 1) chromium.launch was called with default headless + the 3 anti-detection args
    launch_mock.assert_called_once()
    _, launch_kwargs = launch_mock.call_args
    assert launch_kwargs["headless"] is True
    assert launch_kwargs["args"] == [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]

    # 2) new_context received the default UA, viewport and locale
    new_context_mock.assert_called_once()
    _, ctx_kwargs = new_context_mock.call_args
    assert ctx_kwargs["user_agent"] == browser._DEFAULT_UA
    assert ctx_kwargs["viewport"] == browser._DEFAULT_VIEWPORT
    assert ctx_kwargs["locale"] == "en-US"

    # 3) Stealth was instantiated with the 5 default flags and applied to the context
    stealth_cls.assert_called_once_with(**browser._DEFAULT_STEALTH_FLAGS)
    stealth_instance = stealth_cls.return_value
    stealth_instance.apply_stealth_sync.assert_called_once_with(ctx)

    # 4) The 3-tuple shape is honoured and values are the fakes we injected
    assert pw is fake_pw
    assert ctx is fake_context
    assert page is fake_page


def test_close_stealth_ephemeral_still_stops_when_browser_close_raises():
    """Ephemeral: ``browser.close()`` raises → ``playwright.stop()`` still fires."""
    pw = MagicMock(name="playwright")
    ctx = MagicMock(name="context")
    ctx.browser = MagicMock(name="browser")
    ctx.browser.close.side_effect = RuntimeError("chromium crashed")

    with pytest.raises(RuntimeError, match="chromium crashed"):
        close_stealth(pw, ctx)

    pw.stop.assert_called_once()


# ---------------------------------------------------------------------------
# 7. Async launch path (mirrors sync defaults test)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_launch_stealth_async_defaults_applied(monkeypatch):
    """Async launcher must await apply_stealth_async and use the same defaults."""
    from roxabi_sdk.browser import launch_stealth_async

    fake_page = MagicMock(name="page")
    fake_context = MagicMock(name="context")
    fake_context.pages = []
    fake_context.new_page = AsyncMock(return_value=fake_page)

    fake_browser = MagicMock(name="browser")
    fake_browser.new_context = AsyncMock(return_value=fake_context)

    fake_chromium = MagicMock(name="chromium")
    fake_chromium.launch = AsyncMock(return_value=fake_browser)

    fake_pw = MagicMock(name="playwright")
    fake_pw.chromium = fake_chromium

    fake_factory = MagicMock(name="async_playwright_factory")
    fake_factory.start = AsyncMock(return_value=fake_pw)

    fake_async_playwright = MagicMock(name="async_playwright", return_value=fake_factory)

    async_api_mod = types.ModuleType("playwright.async_api")
    async_api_mod.async_playwright = fake_async_playwright

    fake_stealth_cls = MagicMock(name="StealthClass")
    fake_stealth_instance = MagicMock(name="StealthInstance")
    fake_stealth_instance.apply_stealth_async = AsyncMock()
    fake_stealth_cls.return_value = fake_stealth_instance

    stealth_mod = types.ModuleType("playwright_stealth")
    stealth_mod.Stealth = fake_stealth_cls

    pw_root = types.ModuleType("playwright")
    pw_root.async_api = async_api_mod

    monkeypatch.setitem(sys.modules, "playwright", pw_root)
    monkeypatch.setitem(sys.modules, "playwright.async_api", async_api_mod)
    monkeypatch.setitem(sys.modules, "playwright_stealth", stealth_mod)
    monkeypatch.setattr(browser, "_raise_if_unavailable", lambda: None)

    pw, ctx, page = await launch_stealth_async()

    # apply_stealth_async must be awaited (not just called)
    fake_stealth_instance.apply_stealth_async.assert_awaited_once_with(fake_context)

    # Same default launch args as sync
    fake_chromium.launch.assert_awaited_once()
    _, launch_kwargs = fake_chromium.launch.await_args
    assert launch_kwargs["args"] == [
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
    ]

    # 3-tuple shape honoured
    assert pw is fake_pw
    assert ctx is fake_context
    assert page is fake_page
