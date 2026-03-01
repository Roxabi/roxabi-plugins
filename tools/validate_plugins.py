#!/usr/bin/env python3
"""Validate plugin structure and data conventions.

Checks:
- No personal data in plugin source files
- No references to memory.db (should be vault.db)
- No references to _shared/ (2ndBrain legacy)
- data.root is unique across all plugin.json files
- Example files referenced in plugin.json exist
- Vendored paths.py copies match the canonical version
"""
import filecmp
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGINS_DIR = REPO_ROOT / 'plugins'
CANONICAL_PATHS = PLUGINS_DIR / 'vault' / '_lib' / 'paths.py'


def run_grep(pattern: str, path: str = 'plugins/', case_insensitive: bool = True) -> list[str]:
    """Run git grep and return matching lines."""
    cmd = ['git', 'grep']
    if case_insensitive:
        cmd.append('-i')
    cmd.extend([pattern, '--', path])
    result = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_ROOT)
    return [line for line in result.stdout.strip().split('\n') if line]


def get_data_plugins() -> set[str]:
    """Derive vault-aware plugins from plugin.json data sections."""
    plugins = set()
    for plugin_json in PLUGINS_DIR.glob('*/.claude-plugin/plugin.json'):
        with open(plugin_json) as f:
            data = json.load(f)
        if data.get('data') or data.get('vault'):
            plugins.add(plugin_json.parent.parent.name)
    return plugins


def check_personal_data() -> list[str]:
    """No personal data in the repo."""
    errors = []
    for pattern in ['bouly', 'mickael']:
        matches = run_grep(pattern)
        if matches:
            errors.append(f'Personal data found ({pattern}):')
            errors.extend(f'  {m}' for m in matches)
    return errors


def check_legacy_refs() -> list[str]:
    """No references to legacy 2ndBrain patterns in data-aware plugins."""
    errors = []
    data_plugins = get_data_plugins()
    for pattern, label in [('memory\\.db', 'memory.db'), ('_shared/', '_shared/')]:
        matches = run_grep(pattern, case_insensitive=False)
        for match in matches:
            # Extract plugin name from path
            parts = match.split('/')
            if len(parts) >= 2:
                plugin = parts[1]
            else:
                continue
            if plugin not in data_plugins:
                continue
            # Allow memory.db references in vault-migrate skill
            if plugin == 'vault' and label == 'memory.db' and 'vault-migrate' in match:
                continue
            errors.append(f'Legacy reference to {label} in {plugin}: {match}')
    return errors


def check_data_root_uniqueness() -> list[str]:
    """data.root must be unique across all plugins."""
    errors = []
    roots: dict[str, str] = {}
    for plugin_json in PLUGINS_DIR.glob('*/.claude-plugin/plugin.json'):
        plugin_name = plugin_json.parent.parent.name
        with open(plugin_json) as f:
            data = json.load(f)
        root = data.get('data', {}).get('root')
        if root is None:
            continue
        if root in roots:
            errors.append(
                f'Duplicate data.root "{root}": {roots[root]} and {plugin_name}'
            )
        else:
            roots[root] = plugin_name
    return errors


def check_examples_exist() -> list[str]:
    """Example files referenced in plugin.json must exist."""
    errors = []
    for plugin_json in PLUGINS_DIR.glob('*/.claude-plugin/plugin.json'):
        plugin_dir = plugin_json.parent.parent
        plugin_name = plugin_dir.name
        with open(plugin_json) as f:
            data = json.load(f)
        files = data.get('data', {}).get('files', {})
        for file_key, file_info in files.items():
            if isinstance(file_info, dict):
                example = file_info.get('example')
                if example and not (plugin_dir / example).exists():
                    errors.append(
                        f'{plugin_name}: example file not found: {example}'
                    )
    return errors


def check_vendored_paths() -> list[str]:
    """Vendored paths.py copies must match the canonical version."""
    errors = []
    if not CANONICAL_PATHS.exists():
        errors.append('Canonical paths.py not found at plugins/vault/_lib/paths.py')
        return errors
    for vendored in PLUGINS_DIR.glob('*/scripts/_lib/paths.py'):
        plugin_name = vendored.parent.parent.parent.name
        if not filecmp.cmp(CANONICAL_PATHS, vendored, shallow=False):
            errors.append(
                f'{plugin_name}: vendored paths.py differs from canonical '
                f'(plugins/vault/_lib/paths.py)'
            )
    return errors


def main() -> int:
    all_errors = []
    checks = [
        ('Personal data scan', check_personal_data),
        ('Legacy references', check_legacy_refs),
        ('data.root uniqueness', check_data_root_uniqueness),
        ('Example files exist', check_examples_exist),
        ('Vendored paths.py sync', check_vendored_paths),
    ]

    for name, check_fn in checks:
        errors = check_fn()
        if errors:
            print(f'FAIL: {name}')
            for e in errors:
                print(f'  {e}')
            all_errors.extend(errors)
        else:
            print(f'PASS: {name}')

    if all_errors:
        print(f'\n{len(all_errors)} error(s) found.')
        return 1
    print('\nAll checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
