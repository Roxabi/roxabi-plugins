#!/usr/bin/env python3
"""Validate plugin structure and data conventions.

Checks:
- No personal data in plugin source files
- No references to memory.db (legacy)
- No references to _shared/ (2ndBrain legacy)
- data.root is unique across all plugin.json files
- Example files referenced in plugin.json exist
- Vendored paths.py copies match the canonical version
- Fixed /tmp/ literals in SKILL.md files (tempfile-convention.md)
"""
import filecmp
import json
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGINS_DIR = REPO_ROOT / 'plugins'
CANONICAL_PATHS = REPO_ROOT / 'roxabi_sdk' / 'paths.py'


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
        errors.append('Canonical paths.py not found at roxabi_sdk/paths.py')
        return errors
    for vendored in PLUGINS_DIR.glob('*/scripts/_lib/paths.py'):
        plugin_name = vendored.parent.parent.parent.name
        if not filecmp.cmp(CANONICAL_PATHS, vendored, shallow=False):
            errors.append(
                f'{plugin_name}: vendored paths.py differs from canonical '
                f'(roxabi_sdk/paths.py)'
            )
    return errors


def check_tempfile_convention() -> list[str]:
    """SKILL.md files must not hardcode /tmp/<name> literals.

    Enforces plugins/shared/references/tempfile-convention.md.
    Any fixed path must be replaced by `mktemp -d -t <plugin>-<purpose>-<scope>-XXXXXX`
    with a `trap 'rm -rf "$TMPDIR"' EXIT` cleanup.
    """
    errors = []
    # Match any /tmp/<name> where <name> is at least 4 chars of [a-z0-9_-]
    tmp_pattern = re.compile(r'/tmp/[a-z0-9_-]{4,}')
    # Exempt lines that are part of a mktemp invocation or a template XXXXXX marker
    exempt_pattern = re.compile(r'mktemp|XXXXX')

    for skill_md in PLUGINS_DIR.glob('*/skills/**/SKILL.md'):
        plugin_name = skill_md.relative_to(PLUGINS_DIR).parts[0]
        with open(skill_md) as f:
            for lineno, line in enumerate(f, start=1):
                if tmp_pattern.search(line) and not exempt_pattern.search(line):
                    rel = skill_md.relative_to(REPO_ROOT)
                    errors.append(
                        f'{plugin_name}: fixed /tmp/ literal at {rel}:{lineno} '
                        f'→ {line.strip()[:80]}'
                    )
    return errors


def check_class_list_sync() -> list[str]:
    """Inline class list in code-review/SKILL.md spawn template must match review-classes.yml."""
    errors = []
    yaml_path = PLUGINS_DIR / 'dev-core' / 'skills' / 'code-review' / 'review-classes.yml'
    skill_path = PLUGINS_DIR / 'dev-core' / 'skills' / 'code-review' / 'SKILL.md'

    if not yaml_path.exists():
        errors.append(f'review-classes.yml not found at {yaml_path}')
        return errors
    if not skill_path.exists():
        errors.append(f'code-review/SKILL.md not found at {skill_path}')
        return errors

    yaml_slugs: set[str] = set()
    with open(yaml_path) as f:
        for line in f:
            m = re.match(r'\s+-\s+class:\s+(\S+)', line)
            if m:
                yaml_slugs.add(m.group(1))

    inline_slugs: set[str] = set()
    with open(skill_path) as f:
        content = f.read()
    m = re.search(r'Canonical classes \(use slug only\):\s+([^.\\]+)\.', content)
    if not m:
        errors.append('code-review/SKILL.md: canonical class list not found in spawn template')
        return errors
    for slug in m.group(1).split(','):
        slug = slug.strip()
        if slug:
            inline_slugs.add(slug)

    missing = yaml_slugs - inline_slugs
    extra = inline_slugs - yaml_slugs
    if missing:
        errors.append(
            f'code-review/SKILL.md spawn template missing slugs from review-classes.yml: {sorted(missing)}'
        )
    if extra:
        errors.append(
            f'code-review/SKILL.md spawn template has extra slugs not in review-classes.yml: {sorted(extra)}'
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
        ('Tempfile convention', check_tempfile_convention),
        ('Class list sync', check_class_list_sync),
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
