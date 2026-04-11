"""Alias catchability tests for ``PlaywrightNotAvailableError``.

After #93, ``plugins.linkedin-apply.scripts.scraper.PlaywrightNotAvailableError``
must be catchable as both:

* :class:`scripts.scraper.LinkedInScraperError` — for callers that
  ``except LinkedInScraperError`` to handle every scraper failure uniformly.
* :class:`roxabi_sdk.browser.PlaywrightNotAvailableError` — for callers that
  ``except PlaywrightNotAvailableError`` to handle the missing-dep case
  cross-cutting all browser users.

The pre-refactor class only inherited from ``LinkedInScraperError``, so the
SDK-side ``isinstance`` check below is the RED phase: it must fail before
T4.2 introduces the multiple-inheritance alias and pass after.
"""
from __future__ import annotations

import sys
from pathlib import Path

# Match the sys.path bootstrapping used by tests/test_adapters.py.
_plugin_root = str(Path(__file__).resolve().parents[1])
_repo_root = str(Path(__file__).resolve().parents[3])
for _p in (_plugin_root, _repo_root):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from roxabi_sdk.browser import PlaywrightNotAvailableError as SdkPWError
from scripts.scraper import (
    LinkedInScraperError,
    PlaywrightNotAvailableError,
)


def test_alias_is_catchable_as_linkedin_error() -> None:
    """The alias must still satisfy ``except LinkedInScraperError``."""
    exc = PlaywrightNotAvailableError("test msg")
    assert isinstance(exc, LinkedInScraperError)


def test_alias_is_catchable_as_sdk_error() -> None:
    """The alias must also satisfy ``except SdkPWError`` after T4.2."""
    exc = PlaywrightNotAvailableError("test msg")
    assert isinstance(exc, SdkPWError)


def test_alias_has_url_attribute_none() -> None:
    """MRO is left-first → ``LinkedInScraperError.__init__(message, url=None)``.

    The alias does not pass a ``url`` so ``self.url`` should be ``None``.
    Documented in plan T4.2: harmless but non-obvious for SDK errors.
    """
    exc = PlaywrightNotAvailableError("test msg")
    assert exc.url is None
