"""Tests for active curated marketplace projection validation."""

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


def _write_projection(tmp_path, registry_rows, curated_rows):
    registry = tmp_path / 'external-registry.json'
    curated = tmp_path / 'curated-marketplaces.json'
    registry.write_text(json.dumps({'curated_marketplaces': registry_rows}), encoding='utf-8')
    curated.write_text(json.dumps({'marketplaces': curated_rows}), encoding='utf-8')
    return registry, curated


def test_active_registry_entries_are_the_order_independent_runtime_projection(tmp_path):
    registry, curated = _write_projection(
        tmp_path,
        [
            {'name': 'first', 'source': 'https://example.test/first', 'status': 'active'},
            {'name': 'legacy', 'source': 'https://example.test/legacy', 'status': 'deprecated'},
            {'name': 'second', 'source': 'https://example.test/second', 'status': 'active'},
        ],
        [
            {'name': 'second', 'source': 'https://example.test/second'},
            {'name': 'first', 'source': 'https://example.test/first'},
        ],
    )
    assert _load_tool().check_curated_marketplace_projection(registry, curated) == []


def test_source_url_drift_is_rejected(tmp_path):
    registry, curated = _write_projection(
        tmp_path,
        [{'name': 'active', 'source': 'https://example.test/canonical', 'status': 'active'}],
        [{'name': 'active', 'source': 'https://example.test/drifted'}],
    )

    errors = _load_tool().check_curated_marketplace_projection(registry, curated)

    assert len(errors) == 1
    assert 'source mismatch' in errors[0]


def test_registry_duplicate_identities_include_deprecated_entries(tmp_path):
    registry, curated = _write_projection(
        tmp_path,
        [
            {'name': 'active', 'source': 'https://example.test/active', 'status': 'active'},
            {'name': 'active', 'source': 'https://example.test/old', 'status': 'deprecated'},
            {'name': 'old', 'source': 'https://example.test/active', 'status': 'deprecated'},
        ],
        [{'name': 'active', 'source': 'https://example.test/active'}],
    )

    errors = _load_tool().check_curated_marketplace_projection(registry, curated)

    assert len(errors) == 2
    assert any('duplicate marketplace name' in error for error in errors)
    assert any('duplicate marketplace source' in error for error in errors)


def test_missing_or_malformed_registry_input_is_rejected(tmp_path):
    registry = tmp_path / 'external-registry.json'
    curated = tmp_path / 'curated-marketplaces.json'
    curated.write_text(json.dumps({'marketplaces': []}), encoding='utf-8')

    errors = _load_tool().check_curated_marketplace_projection(registry, curated)

    assert len(errors) == 1
    assert 'external-registry.json not found' in errors[0]

    registry.write_text(json.dumps({'curated_marketplaces': []}), encoding='utf-8')
    curated.unlink()
    errors = _load_tool().check_curated_marketplace_projection(registry, curated)

    assert len(errors) == 1
    assert 'curated-marketplaces.json not found' in errors[0]

    curated.write_text(json.dumps({'marketplaces': []}), encoding='utf-8')
    registry.write_text('{not json', encoding='utf-8')
    errors = _load_tool().check_curated_marketplace_projection(registry, curated)

    assert len(errors) == 1
    assert 'failed to parse external-registry.json' in errors[0]
