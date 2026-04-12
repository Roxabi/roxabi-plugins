"""Stealth-patched Chromium launcher for Roxabi plugins.

Contract source: artifacts/specs/93-extract-browser-bootstrap-spec.mdx

This module deduplicates the playwright + playwright-stealth bootstrap that
used to live in three call sites (web-intel × 2 sync, linkedin-apply × 1 async).
It exposes:

* :func:`launch_stealth_sync` / :func:`launch_stealth_async` — uniform
  ``(playwright, context, page)`` returners that handle ephemeral and
  persistent (``user_data_dir``) launches identically and apply
  ``Stealth().apply_stealth_{sync,async}(context)`` BEFORE any page is
  created (the only idiom that actually patches in playwright-stealth==2.0.2;
  see V0 probe in PR description).
* :func:`close_stealth` / :func:`close_stealth_async` — paired teardown
  helpers that close the right object (``browser`` for ephemeral, ``context``
  for persistent) and always stop the Playwright driver.
* :class:`PlaywrightNotAvailableError` — typed sentinel raised when either
  playwright or playwright-stealth is missing. Subclasses ``RuntimeError``
  so it stays catchable as a generic runtime failure too.

Playwright is imported lazily inside each entrypoint so this module remains
importable in environments where the optional ``[twitter]`` extra is not
installed (CI guard test SC-17).
"""
from __future__ import annotations

import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    # Forward references only; never imported at runtime.
    from playwright.async_api import (
        BrowserContext as AsyncBrowserContext,
        Page as AsyncPage,
        Playwright as AsyncPlaywright,
    )
    from playwright.sync_api import (
        BrowserContext as SyncBrowserContext,
        Page as SyncPage,
        Playwright as SyncPlaywright,
    )

__all__ = [
    "PlaywrightNotAvailableError",
    "launch_stealth_sync",
    "launch_stealth_async",
    "close_stealth",
    "close_stealth_async",
]

_INSTALL_HINT = (
    "playwright or playwright-stealth not installed. Install with: "
    "uv sync --extra twitter && uv run playwright install chromium "
    "(or: pip install playwright playwright-stealth && playwright install chromium)"
)


class PlaywrightNotAvailableError(RuntimeError):
    """Raised when playwright/playwright-stealth cannot be imported.

    Subclasses :class:`RuntimeError` (not :class:`ImportError`) so callers
    that already catch ``RuntimeError`` keep working, while still getting a
    typed sentinel for targeted handling.
    """


def _raise_if_unavailable() -> None:
    """Eagerly import playwright + playwright-stealth or raise typed error."""
    try:
        import playwright  # noqa: F401
        import playwright_stealth  # noqa: F401
    except ImportError as exc:
        raise PlaywrightNotAvailableError(_INSTALL_HINT) from exc


_DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
_DEFAULT_VIEWPORT = {"width": 1280, "height": 900}
_DEFAULT_LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
]
_DEFAULT_STEALTH_FLAGS = {
    "navigator_webdriver": True,
    "chrome_runtime": True,
    "navigator_plugins": True,
    "navigator_permissions": True,
    "webgl_vendor": True,
}


def launch_stealth_sync(
    *,
    user_data_dir: str | None = None,
    headless: bool = True,
    user_agent: str | None = None,
    viewport: dict | None = None,
    locale: str = "en-US",
    stealth_flags: dict | None = None,
    launch_args: list[str] | None = None,
) -> tuple[SyncPlaywright, SyncBrowserContext, SyncPage]:
    """Launch a stealth-patched Chromium and return ``(playwright, context, page)``.

    Either ephemeral (``user_data_dir=None``, default) or persistent (when
    ``user_data_dir`` is set, the directory is created on demand and a
    ``launch_persistent_context`` is used). In both shapes the stealth
    patches are applied to the **context** before any page is opened — this
    is the only idiom that actually patches in playwright-stealth==2.0.2
    (the V0 probe in #93 verified that ``Stealth().use_sync(page)`` called
    after ``context.new_page()`` is a no-op).

    The caller owns the returned tuple and must call :func:`close_stealth`
    in a ``finally`` block to release the Chromium process and Playwright
    driver.

    Raises:
        PlaywrightNotAvailableError: if playwright or playwright-stealth
            cannot be imported.
    """
    _raise_if_unavailable()
    from playwright.sync_api import sync_playwright
    from playwright_stealth import Stealth

    ua = user_agent or _DEFAULT_UA
    vp = viewport or _DEFAULT_VIEWPORT
    la = launch_args if launch_args is not None else _DEFAULT_LAUNCH_ARGS
    sf = stealth_flags if stealth_flags is not None else _DEFAULT_STEALTH_FLAGS

    pw = sync_playwright().start()
    try:
        if user_data_dir is not None:
            os.makedirs(user_data_dir, exist_ok=True)
            ctx = pw.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=headless,
                viewport=vp,
                locale=locale,
                user_agent=ua,
                args=la,
            )
        else:
            browser = pw.chromium.launch(headless=headless, args=la)
            ctx = browser.new_context(user_agent=ua, viewport=vp, locale=locale)
        Stealth(**sf).apply_stealth_sync(ctx)
        page = ctx.new_page()
        return pw, ctx, page
    except Exception:
        pw.stop()
        raise


async def launch_stealth_async(
    *,
    user_data_dir: str | None = None,
    headless: bool = True,
    user_agent: str | None = None,
    viewport: dict | None = None,
    locale: str = "en-US",
    stealth_flags: dict | None = None,
    launch_args: list[str] | None = None,
) -> tuple[AsyncPlaywright, AsyncBrowserContext, AsyncPage]:
    """Async mirror of :func:`launch_stealth_sync`.

    Must run inside the caller's existing event loop. This function does
    NOT call :func:`asyncio.run` or :func:`asyncio.get_event_loop` — callers
    like ``linkedin-apply.scripts.scraper.get_browser_context`` already own
    a running loop and ``await`` this entrypoint directly.
    """
    _raise_if_unavailable()
    from playwright.async_api import async_playwright
    from playwright_stealth import Stealth

    ua = user_agent or _DEFAULT_UA
    vp = viewport or _DEFAULT_VIEWPORT
    la = launch_args if launch_args is not None else _DEFAULT_LAUNCH_ARGS
    sf = stealth_flags if stealth_flags is not None else _DEFAULT_STEALTH_FLAGS

    pw = await async_playwright().start()
    try:
        if user_data_dir is not None:
            os.makedirs(user_data_dir, exist_ok=True)
            ctx = await pw.chromium.launch_persistent_context(
                user_data_dir=user_data_dir,
                headless=headless,
                viewport=vp,
                locale=locale,
                user_agent=ua,
                args=la,
            )
        else:
            browser = await pw.chromium.launch(headless=headless, args=la)
            ctx = await browser.new_context(user_agent=ua, viewport=vp, locale=locale)
        await Stealth(**sf).apply_stealth_async(ctx)
        page = await ctx.new_page()
        return pw, ctx, page
    except Exception:
        await pw.stop()
        raise


def close_stealth(
    playwright: SyncPlaywright, context: SyncBrowserContext
) -> None:
    """Tear down a sync stealth session.

    Closes the right object based on context shape:

    * **Ephemeral** (``context.browser`` is a real ``Browser`` instance):
      close the browser, which closes the context implicitly.
    * **Persistent** (``context.browser is None``, the persistent context
      owns its browser process directly): close the context.

    Always stops the Playwright driver in the ``finally`` clause so a
    misbehaving close still releases the supervisor process.
    """
    try:
        browser = context.browser
        if browser is not None:
            browser.close()
        else:
            context.close()
    finally:
        playwright.stop()


async def close_stealth_async(
    playwright: AsyncPlaywright, context: AsyncBrowserContext
) -> None:
    """Async mirror of :func:`close_stealth`."""
    try:
        browser = context.browser
        if browser is not None:
            await browser.close()
        else:
            await context.close()
    finally:
        await playwright.stop()
