"""Tests for the Python license gate, plugins/dev-core/tools/license_check.py.

The gate allows a package when its license evaluates to a safe license. A false
"allowed" ships a disallowed license, so every way an expression can be read
more permissively than written is pinned here: precedence, grouping, a missing
operand, WITH without its exception, and pip-licenses' ";" classifier lists.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
CHECKER = REPO_ROOT / 'plugins' / 'dev-core' / 'tools' / 'license_check.py'


@pytest.fixture
def lc():
    spec = importlib.util.spec_from_file_location('license_check', CHECKER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.mark.parametrize(
    ('expr', 'allowed'),
    [
        ('MIT', True),
        ('MIT OR GPL-3.0', True),
        ('GPL-3.0 OR MIT', True),
        ('MIT AND ISC', True),
        ('MIT AND GPL-3.0', False),
        # AND binds tighter than OR
        ('MIT OR GPL-3.0 AND GPL-2.0', True),
        ('GPL-3.0 AND GPL-2.0 OR MIT', True),
        ('(MIT OR GPL-3.0) AND GPL-2.0', False),
        ('(MIT OR GPL-3.0) AND (ISC OR GPL-2.0)', True),
        # pip-licenses joins classifiers with ";": every one must be allowed
        ('Apache Software License; MIT License', True),
        ('MIT License; GNU General Public License v3 (GPLv3)', False),
        # an operand may be a classifier name of several words
        ('Apache License 2.0 OR GPL-3.0', True),
        ('MIT GPL-3.0', False),
        # a name with no operator is not an expression: disallowed unless listed, no warning
        ('GNU General Public License v3 (GPLv3)', False),
        ('()', False),
        ('LGPL-2.1+', True),
        ('', False),
    ],
)
def test_evaluates_the_expression_as_written(lc, capsys, expr, allowed):
    assert lc.is_license_allowed(expr) is allowed
    assert capsys.readouterr().err == ''


@pytest.mark.parametrize(
    'expr',
    [
        '(MIT OR GPL-3.0',
        'MIT) AND GPL-3.0',
        'MIT OR )',
        'MIT OR',
        'OR MIT',
        'MIT OR OR',
        'MIT AND',
        'MIT OR WITH',
        'MIT WITH',
        'MIT OR GPL-3.0 WITH (',
        '(MIT OR X WITH ) AND GPL-3.0 )',
    ],
)
def test_a_malformed_expression_is_disallowed_and_says_why(lc, capsys, expr):
    assert lc.is_license_allowed(expr) is False
    err = capsys.readouterr().err
    assert err.count('\n') == 1
    assert 'malformed SPDX expression' in err


@pytest.mark.parametrize(
    'expr',
    [
        '(' * 21 + 'MIT' + ')' * 21,
        ' OR '.join(['MIT'] * 74),  # 514 characters, no paren
    ],
)
def test_an_over_complex_expression_is_disallowed_and_says_why(lc, capsys, expr):
    assert lc.is_license_allowed(expr) is False
    assert 'too complex' in capsys.readouterr().err


def test_the_warning_cannot_start_a_line_of_its_own(lc, capsys):
    # A newline in package metadata would let a package write a workflow command
    # (::error::, ::add-mask::) into a GitHub Actions log.
    assert lc.is_license_allowed('(MIT OR\n::error::spoofed') is False
    err = capsys.readouterr().err
    assert err.count('\n') == 1
    assert '\n::' not in err


def _run_main(lc, monkeypatch, capsys, tmp_path, packages, policy=None):
    policy_path = tmp_path / '.license-policy.json'
    if policy is not None:
        policy_path.write_text(json.dumps(policy), encoding='utf-8')
    monkeypatch.setattr(lc, 'get_packages', lambda: packages)
    monkeypatch.setattr(sys, 'argv', ['license_check.py', '--json', '--policy', str(policy_path)])
    with pytest.raises(SystemExit) as exit_info:
        lc.main()
    return exit_info.value.code, json.loads(capsys.readouterr().out)


def test_an_unknown_license_fails_the_check_apart_from_violations(lc, monkeypatch, capsys, tmp_path):
    code, report = _run_main(
        lc,
        monkeypatch,
        capsys,
        tmp_path,
        [
            {'Name': 'mystery', 'Version': '1.0', 'License': 'UNKNOWN'},
            {'Name': 'blank', 'Version': '1.0', 'License': None},
            {'Name': 'fine', 'Version': '1.0', 'License': 'MIT'},
        ],
    )
    assert code == 1
    assert [u['name'] for u in report['unresolved']] == ['mystery', 'blank']
    assert report['violating'] == []


def test_the_policy_covers_an_unknown_license_by_name(lc, monkeypatch, capsys, tmp_path):
    code, report = _run_main(
        lc,
        monkeypatch,
        capsys,
        tmp_path,
        [{'Name': 'mystery', 'Version': '1.0', 'License': 'UNKNOWN'}],
        {'allowlist': ['mystery']},
    )
    assert code == 0
    assert report['unresolved'] == []
