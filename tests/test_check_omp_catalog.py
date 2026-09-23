"""Tests for the OMP catalog check in tools/validate_plugins.py.

OMP keys a marketplace install's cache on the `.omp-plugin/marketplace.json` row
version, not on package.json (#568). #491 bumped package.json only: the machine
installed new content under the old cache key and `omp plugin upgrade` saw nothing.
"""

import importlib.util
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
TOOL = REPO_ROOT / 'tools' / 'validate_plugins.py'


def _load_tool():
    """Import tools/validate_plugins.py as a module."""
    spec = importlib.util.spec_from_file_location('validate_plugins', TOOL)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _tree(tmp_path, rows, packages):
    """Write a catalog with `rows` and one plugins/<name>/package.json per `packages` entry."""
    catalog = tmp_path / '.omp-plugin' / 'marketplace.json'
    catalog.parent.mkdir(parents=True)
    catalog.write_text(json.dumps({'name': 'mp', 'owner': {'name': 'o'}, 'plugins': rows}), encoding='utf-8')
    for name, package in packages.items():
        plugin_dir = tmp_path / 'plugins' / name
        plugin_dir.mkdir(parents=True)
        if package is not None:
            (plugin_dir / 'package.json').write_text(json.dumps(package), encoding='utf-8')
    return catalog


def _row(name, version=None):
    row = {'name': name, 'source': f'./plugins/{name}'}
    if version is not None:
        row['version'] = version
    return row


def test_version_bumped_in_package_json_only_is_drift(tmp_path):
    mod = _load_tool()
    catalog = _tree(tmp_path, [_row('omp-build', '0.2.0')], {'omp-build': {'name': 'omp-build', 'version': '0.3.0'}})
    errors = mod.check_omp_catalog(catalog, tmp_path)
    assert len(errors) == 1
    assert errors[0].startswith('omp-build:')
    assert "'0.2.0'" in errors[0] and "'0.3.0'" in errors[0]


def test_version_declared_on_one_side_only_is_drift(tmp_path):
    mod = _load_tool()
    catalog = _tree(
        tmp_path,
        [_row('catalog-only', '1.0.0'), _row('package-only')],
        {'catalog-only': {'name': 'catalog-only'}, 'package-only': {'name': 'package-only', 'version': '1.0.0'}},
    )
    errors = mod.check_omp_catalog(catalog, tmp_path)
    assert sorted(e.split(':')[0] for e in errors) == ['catalog-only', 'package-only']


def test_invalid_json_fails_the_whole_catalog(tmp_path):
    mod = _load_tool()
    catalog = tmp_path / '.omp-plugin' / 'marketplace.json'
    catalog.parent.mkdir(parents=True)
    catalog.write_text('{"plugins": [{"name": "x",}]}', encoding='utf-8')
    errors = mod.check_omp_catalog(catalog, tmp_path)
    assert len(errors) == 1
    assert mod._is_io_error(errors[0])


def test_source_that_is_not_a_directory_is_reported(tmp_path):
    mod = _load_tool()
    catalog = _tree(tmp_path, [_row('ghost', '1.0.0')], {})
    errors = mod.check_omp_catalog(catalog, tmp_path)
    assert errors == ['ghost: OMP catalog source ./plugins/ghost is not a directory']


def test_matching_versions_and_unpackaged_rows_pass(tmp_path):
    mod = _load_tool()
    catalog = _tree(
        tmp_path,
        [_row('versioned', '0.3.0'), _row('unversioned'), _row('no-package')],
        {
            'versioned': {'name': 'versioned', 'version': '0.3.0'},
            'unversioned': {'name': 'unversioned'},
            'no-package': None,
        },
    )
    assert mod.check_omp_catalog(catalog, tmp_path) == []
