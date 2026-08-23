"""Tests for the no-plugin-version-pins check in tools/validate_plugins.py."""

import importlib.util
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / 'tools' / 'validate_plugins.py'


def _load_tool():
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_shipped_tree_has_no_plugin_version_pins():
    errors = _load_tool().check_no_plugin_version_pins()
    assert errors == []


def test_plugin_json_version_is_rejected(tmp_path):
    plugin_json = tmp_path / 'dev-core' / '.claude-plugin' / 'plugin.json'
    plugin_json.parent.mkdir(parents=True)
    plugin_json.write_text(json.dumps({'name': 'dev-core', 'version': '0.12.3'}))
    errors = _load_tool().check_no_plugin_version_pins(
        plugins_dir=tmp_path, marketplace_path=tmp_path / 'missing.json'
    )
    assert len(errors) == 1
    assert 'dev-core' in errors[0]
    assert '0.12.3' in errors[0]


def test_marketplace_plugin_entry_version_is_rejected(tmp_path):
    market = tmp_path / 'marketplace.json'
    market.write_text(json.dumps({
        'name': 'roxabi-marketplace',
        'version': '1.0.0',
        'plugins': [{'name': 'dev-core', 'version': '0.12.3', 'source': './plugins/dev-core'}],
    }))
    errors = _load_tool().check_no_plugin_version_pins(
        plugins_dir=tmp_path / 'empty', marketplace_path=market
    )
    assert len(errors) == 1
    assert 'dev-core' in errors[0]
    assert '0.12.3' in errors[0]


def test_marketplace_top_level_version_is_allowed(tmp_path):
    market = tmp_path / 'marketplace.json'
    market.write_text(json.dumps({
        'name': 'roxabi-marketplace',
        'version': '1.0.0',
        'plugins': [{'name': 'dev-core', 'source': './plugins/dev-core'}],
    }))
    errors = _load_tool().check_no_plugin_version_pins(
        plugins_dir=tmp_path / 'empty', marketplace_path=market
    )
    assert errors == []
