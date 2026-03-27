#!/usr/bin/env python3
"""
content-lab dependency doctor.

Checks core and optional dependencies.
Run: uv run python scripts/doctor.py

Exit codes:
    0 — all core dependencies pass
    1 — one or more core dependencies failed
"""
from __future__ import annotations

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


def check_web_intel() -> tuple[str, str]:
    """Check web-intel plugin is available (required for scraping)."""
    import os
    # Check common locations
    candidates = [
        os.path.expanduser('~/projects/roxabi-plugins/plugins/web-intel/pyproject.toml'),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return 'ok', f'web-intel found at {os.path.dirname(c)}'

    # Try find
    try:
        result = subprocess.run(
            ['find', os.path.expanduser('~/projects'), '-maxdepth', '4',
             '-path', '*/web-intel/pyproject.toml', '-print', '-quit'],
            capture_output=True, text=True, timeout=10,
        )
        if result.stdout.strip():
            return 'ok', f'web-intel found at {os.path.dirname(result.stdout.strip())}'
    except Exception:
        pass

    return 'fail', 'web-intel plugin not found. Required for YouTube scraping.'


STATUS_SYMBOLS = {
    'ok':   'PASS',
    'warn': 'WARN',
    'fail': 'FAIL',
}


def main() -> int:
    """Run all checks and print report."""
    print('content-lab doctor')
    print('=' * 40)
    print()

    core_checks = [
        ('Python >= 3.11',     check_python_version()),
        ('uv package manager', check_uv()),
        ('web-intel plugin',   check_web_intel()),
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

    core_ok = sum(1 for _, (s, _) in core_checks if s == 'ok')
    core_total = len(core_checks)

    print('=' * 40)
    print(f'Core: {core_ok}/{core_total} passed')

    if has_core_failure:
        print()
        print('RESULT: FAIL — fix core dependencies above before using content-lab.')
        return 1

    print()
    print('RESULT: OK — all dependencies available.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
