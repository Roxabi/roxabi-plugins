"""Locate roxabi_sdk without hardcoding checkout depth.

Chicken-and-egg: this helper cannot live inside roxabi_sdk — each plugin root
carries an identical copy. Stdlib only (os, sys, pathlib).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _has_sdk(root: Path) -> bool:
    return (root / 'roxabi_sdk' / 'paths.py').is_file()


def find_sdk_root(start: Path | str | None = None) -> Path:
    """Return the directory that contains `roxabi_sdk/paths.py`.

    Resolution order (first hit wins):
      1. ``ROXABI_SDK_HOME``, if set and it contains ``roxabi_sdk/paths.py``
      2. Walk upward from ``start`` (default: this file) looking for the marker
      3. If an ancestor is named ``cache`` whose parent is named ``plugins``,
         check ``<plugins>/marketplaces/<marketplace-name>/`` where
         ``<marketplace-name>`` is the directory directly under ``cache``

    Raises ``ModuleNotFoundError`` naming what was searched when nothing matches.
    """
    start_path = Path(start).resolve() if start is not None else Path(__file__).resolve()
    searched: list[str] = []

    override = os.environ.get('ROXABI_SDK_HOME')
    if override:
        candidate = Path(override).expanduser().resolve()
        searched.append(str(candidate))
        if _has_sdk(candidate):
            return candidate

    current = start_path if start_path.is_dir() else start_path.parent
    while True:
        searched.append(str(current))
        if _has_sdk(current):
            return current

        # Installed layout: .../plugins/cache/<marketplace>/<plugin>/<hash>/...
        if current.name == 'cache' and current.parent.name == 'plugins':
            marketplace = next(
                (ancestor.name for ancestor in start_path.parents if ancestor.parent == current),
                None,
            )
            if marketplace:
                clone = current.parent / 'marketplaces' / marketplace
                searched.append(str(clone))
                if _has_sdk(clone):
                    return clone

        if current.parent == current:
            break
        current = current.parent

    raise ModuleNotFoundError(
        'roxabi_sdk not found. Searched: '
        + '; '.join(searched)
        + '. The marketplace clone appears incomplete — expected roxabi_sdk/paths.py '
        'under ROXABI_SDK_HOME, an ancestor of the entrypoint, or '
        '<plugins>/marketplaces/<marketplace>/.'
    )


def ensure_sdk_on_path(start: Path | str | None = None) -> Path:
    """Insert the SDK root on ``sys.path`` (idempotent) and return it."""
    root = find_sdk_root(start)
    root_s = str(root)
    if root_s not in sys.path:
        sys.path.insert(0, root_s)
    return root
