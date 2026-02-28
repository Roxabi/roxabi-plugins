#!/usr/bin/env python3
"""
web-intel dependency doctor.

Checks all core and optional dependencies for the web-intel plugin.
Run: uv run python scripts/doctor.py

Exit codes:
    0 — all core dependencies pass (optional may have warnings)
    1 — one or more core dependencies failed
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys


def check_python_version() -> tuple[str, str]:
    """Check Python >= 3.11."""
    v = sys.version_info
    version_str = f'{v.major}.{v.minor}.{v.micro}'
    if (v.major, v.minor) >= (3, 11):
        return 'ok', f'Python {version_str}'
    return 'fail', f'Python {version_str} (need >= 3.11)'


def check_uv() -> tuple[str, str]:
    """Check uv package manager is installed."""
    path = shutil.which('uv')
    if path:
        try:
            result = subprocess.run(
                ['uv', '--version'],
                capture_output=True, text=True, timeout=5,
            )
            version = result.stdout.strip()
            return 'ok', version
        except Exception:
            return 'ok', f'uv found at {path}'
    return 'fail', 'uv not found. Install: https://docs.astral.sh/uv/'


def check_import(module_name: str, pip_name: str | None = None) -> tuple[str, str]:
    """Check if a Python module is importable."""
    pip_name = pip_name or module_name
    try:
        mod = __import__(module_name)
        version = getattr(mod, '__version__', 'installed')
        return 'ok', f'{module_name} {version}'
    except ImportError:
        return 'fail', f'{module_name} not found. Run: uv add {pip_name}'


def check_trafilatura() -> tuple[str, str]:
    """Check trafilatura (optional — generic webpage extraction)."""
    try:
        import trafilatura
        version = getattr(trafilatura, '__version__', 'installed')
        return 'ok', f'trafilatura {version}'
    except ImportError:
        return 'warn', 'trafilatura not installed. Run: uv sync --extra scraper'


def check_playwright() -> tuple[str, str]:
    """Check playwright + chromium browser (optional — Twitter/X articles)."""
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        return 'warn', 'playwright not installed. Run: uv sync --extra twitter'

    # Check if chromium browser binary is installed
    candidates = [
        os.path.join(os.path.expanduser('~'), '.cache', 'ms-playwright'),
        os.path.join(os.path.expanduser('~'), 'Library', 'Caches', 'ms-playwright'),
    ]
    for browsers_path in candidates:
        if os.path.isdir(browsers_path):
            chromium_dirs = [
                d for d in os.listdir(browsers_path)
                if d.startswith('chromium')
            ]
            if chromium_dirs:
                return 'ok', 'playwright + chromium'
            return 'warn', (
                'playwright installed but chromium missing. '
                'Run: uv run playwright install chromium'
            )

    return 'warn', (
        'playwright installed but chromium not detected. '
        'Run: uv run playwright install chromium'
    )


def check_youtube_transcript() -> tuple[str, str]:
    """Check youtube-transcript-api (optional — YouTube transcripts)."""
    try:
        import youtube_transcript_api  # noqa: F401
        version = getattr(youtube_transcript_api, '__version__', 'installed')
        return 'ok', f'youtube-transcript-api {version}'
    except ImportError:
        return 'warn', (
            'youtube-transcript-api not installed. '
            'Run: uv sync --extra youtube'
        )


def check_gh_cli() -> tuple[str, str]:
    """Check GitHub CLI (optional — GitHub repo/gist scraping)."""
    path = shutil.which('gh')
    if not path:
        return 'warn', 'gh CLI not found. Install: https://cli.github.com/'
    try:
        result = subprocess.run(
            ['gh', '--version'],
            capture_output=True, text=True, timeout=5,
        )
        first_line = result.stdout.strip().split('\n')[0]
        return 'ok', first_line
    except Exception:
        return 'ok', f'gh found at {path}'


STATUS_SYMBOLS = {
    'ok':   'PASS',
    'warn': 'WARN',
    'fail': 'FAIL',
}


def main() -> int:
    """Run all checks and print report."""
    print('web-intel doctor')
    print('=' * 40)
    print()

    core_checks = [
        ('Python >= 3.11',     check_python_version()),
        ('uv package manager', check_uv()),
        ('requests',           check_import('requests')),
        ('httpx',              check_import('httpx')),
        ('filelock',           check_import('filelock')),
    ]

    optional_checks = [
        ('trafilatura (generic webpages)',             check_trafilatura()),
        ('playwright + chromium (Twitter/X articles)', check_playwright()),
        ('youtube-transcript-api (YouTube)',           check_youtube_transcript()),
        ('gh CLI (GitHub repos/gists)',                check_gh_cli()),
    ]

    has_core_failure = False

    print('Core Dependencies')
    print('-' * 40)
    for name, (status, detail) in core_checks:
        symbol = STATUS_SYMBOLS[status]
        print(f'  [{symbol}] {name}')
        print(f'         {detail}')
        if status == 'fail':
            has_core_failure = True
    print()

    print('Optional Dependencies')
    print('-' * 40)
    for name, (status, detail) in optional_checks:
        symbol = STATUS_SYMBOLS[status]
        print(f'  [{symbol}] {name}')
        print(f'         {detail}')
    print()

    core_ok = sum(1 for _, (s, _) in core_checks if s == 'ok')
    core_total = len(core_checks)
    opt_ok = sum(1 for _, (s, _) in optional_checks if s == 'ok')
    opt_total = len(optional_checks)

    print('=' * 40)
    print(f'Core: {core_ok}/{core_total} passed')
    print(f'Optional: {opt_ok}/{opt_total} available')

    if has_core_failure:
        print()
        print('RESULT: FAIL — fix core dependencies above before using web-intel.')
        return 1

    if opt_ok < opt_total:
        print()
        print(
            'RESULT: OK — core ready. Install optional deps above to '
            'unlock all platforms.'
        )
        print()
        print('Quick install all optional deps:')
        print('  uv sync --extra all && uv run playwright install chromium')
    else:
        print()
        print('RESULT: OK — all dependencies available.')

    return 0


if __name__ == '__main__':
    sys.exit(main())
