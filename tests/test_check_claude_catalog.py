"""Tests for Claude marketplace version validation."""

import importlib.util
import json
from pathlib import Path


TOOL = Path(__file__).resolve().parents[1] / 'tools' / 'validate_plugins.py'


def _load_tool():
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _tree(tmp_path, rows, packages, metadata=None):
    catalog = tmp_path / '.claude-plugin' / 'marketplace.json'
    catalog.parent.mkdir()
    document = {'plugins': rows} if metadata is None else {'metadata': metadata, 'plugins': rows}
    catalog.write_text(json.dumps(document), encoding='utf-8')
    for name, package in packages.items():
        path = tmp_path / 'plugins' / name / 'package.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps(package), encoding='utf-8')
    return catalog


def test_matching_versions_pass(tmp_path):
    catalog = _tree(tmp_path, [{'name': 'example', 'source': './plugins/example', 'version': '1.2.3'}],
                    {'example': {'version': '1.2.3'}})
    assert _load_tool().check_claude_catalog_versions(catalog, tmp_path) == []


def test_mismatch_reports_plugin_and_both_versions(tmp_path):
    catalog = _tree(tmp_path, [{'name': 'example', 'source': './plugins/example', 'version': '1.2.3'}],
                    {'example': {'version': '1.2.4'}})
    errors = _load_tool().check_claude_catalog_versions(catalog, tmp_path)
    assert len(errors) == 1
    assert 'example' in errors[0] and '1.2.3' in errors[0] and '1.2.4' in errors[0]
    assert 'plugins/example/package.json' in errors[0]


def test_trailing_slash_and_plugin_root_spellings_reach_the_package(tmp_path):
    rows = [
        {'name': 'slash', 'source': './plugins/slash/', 'version': '1.0.0'},
        {'name': 'bare', 'source': 'bare', 'version': '1.0.0'},
    ]
    catalog = _tree(tmp_path, rows, {'slash': {'version': '2.0.0'}, 'bare': {'version': '2.0.0'}},
                    metadata={'pluginRoot': './plugins'})
    errors = _load_tool().check_claude_catalog_versions(catalog, tmp_path)
    assert len(errors) == 2
    assert 'plugins/slash/package.json' in errors[0] and 'plugins/bare/package.json' in errors[1]


def test_row_without_version_is_skipped(tmp_path):
    catalog = _tree(tmp_path, [{'name': 'example', 'source': './plugins/example'}],
                    {'example': {'version': '1.2.3'}})
    assert _load_tool().check_claude_catalog_versions(catalog, tmp_path) == []


def test_missing_package_is_skipped(tmp_path):
    catalog = _tree(tmp_path, [{'name': 'example', 'source': './plugins/example', 'version': '1.2.3'}], {})
    assert _load_tool().check_claude_catalog_versions(catalog, tmp_path) == []


def test_remote_and_non_plugin_sources_are_skipped(tmp_path):
    rows = [
        {'name': 'remote', 'source': {'source': 'github', 'repo': 'example/plugin'}, 'version': '1'},
        {'name': 'other', 'source': './other/example', 'version': '1'},
    ]
    catalog = _tree(tmp_path, rows, {})
    assert _load_tool().check_claude_catalog_versions(catalog, tmp_path) == []


def test_invalid_package_reports_parse_error(tmp_path):
    catalog = _tree(tmp_path, [{'name': 'example', 'source': './plugins/example', 'version': '1'}],
                    {'example': {'version': '1'}})
    (tmp_path / 'plugins' / 'example' / 'package.json').write_text('{', encoding='utf-8')
    errors = _load_tool().check_claude_catalog_versions(catalog, tmp_path)
    assert len(errors) == 1 and 'failed to parse plugins/example/package.json' in errors[0]
