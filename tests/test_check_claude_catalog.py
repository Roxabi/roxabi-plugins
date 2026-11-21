"""Tests for Claude marketplace row validation."""

import importlib.util
import json
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / 'tools' / 'validate_plugins.py'


def _load_tool():
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _check(tmp_path, rows, packages):
    catalog = tmp_path / '.claude-plugin' / 'marketplace.json'
    catalog.parent.mkdir()
    catalog.write_text(json.dumps({'plugins': rows}), encoding='utf-8')
    for name, package in packages.items():
        path = tmp_path / 'plugins' / name / 'package.json'
        path.parent.mkdir(parents=True)
        path.write_text(package if isinstance(package, str) else json.dumps(package), encoding='utf-8')
    return _load_tool().check_claude_catalog_rows(catalog, tmp_path)


def _row(name='example', **fields):
    return {'name': name, 'source': f'./plugins/{name}', **fields}


def test_matching_version_passes(tmp_path):
    assert _check(tmp_path, [_row(version='1.2.3')], {'example': {'version': '1.2.3'}}) == []


def test_version_mismatch_names_the_package(tmp_path):
    errors = _check(tmp_path, [_row(version='1.2.3')], {'example': {'version': '1.2.4'}})
    assert len(errors) == 1
    assert "'1.2.3'" in errors[0] and "'1.2.4'" in errors[0] and 'plugins/example/package.json' in errors[0]


@pytest.mark.parametrize('version', [None, '', 2, '1.2.3\n'])
def test_version_must_be_a_non_empty_single_line_string(tmp_path, version):
    errors = _check(tmp_path, [_row(version=version)], {'example': {'version': '1.2.3'}})
    assert len(errors) == 1 and 'non-empty single-line string' in errors[0]


def test_row_without_version_or_package_is_not_compared(tmp_path):
    rows = [_row(), _row('nopackage', version='1.0.0')]
    assert _check(tmp_path, rows, {'example': {'version': '1.2.3'}}) == []


# The version gate finds the row by name, so a local row must be named after its directory.
@pytest.mark.parametrize('source', ['./plugins/other', './plugins/example/', './plugins/./example', 'example'])
def test_local_source_must_be_plugins_slash_name(tmp_path, source):
    errors = _check(tmp_path, [{'name': 'example', 'source': source, 'version': '1.2.3'}], {})
    assert len(errors) == 1 and 'must be ./plugins/example' in errors[0]


def test_duplicate_names_are_rejected_case_insensitively(tmp_path):
    rows = [_row(version='1.0.0'), {'name': 'Example', 'source': {'source': 'github', 'repo': 'a/b'}}]
    errors = _check(tmp_path, rows, {'example': {'version': '1.0.0'}})
    assert errors == ['Example: duplicate name in Claude catalog']


def test_remote_source_is_not_compared_with_a_local_package(tmp_path):
    rows = [{'name': 'example', 'source': {'source': 'git-subdir', 'url': 'x', 'path': 'plugins/example'}, 'version': '9'}]
    assert _check(tmp_path, rows, {'example': {'version': '1.0.0'}}) == []


def test_unparsable_package_is_reported(tmp_path):
    errors = _check(tmp_path, [_row(version='1')], {'example': '{'})
    assert len(errors) == 1 and 'failed to parse plugins/example/package.json' in errors[0]
