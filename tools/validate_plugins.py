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
- Inline class list in code-review/SKILL.md spawn template matches review-classes.yml
- Subsumption pairs declared in review-classes.yml notes are mentioned together in
  code-review/SKILL.md (prevents drift in pair definitions across files)

Usage:
  python3 tools/validate_plugins.py                     # run all checks
  python3 tools/validate_plugins.py --check class-list-sync     # run only class-list-sync
  python3 tools/validate_plugins.py --check subsumption-pairs   # run only subsumption-pairs
"""
import argparse
import filecmp
import json
import re
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGINS_DIR = REPO_ROOT / 'plugins'
CANONICAL_PATHS = REPO_ROOT / 'roxabi_sdk' / 'paths.py'

_DEFAULT_YAML_PATH = PLUGINS_DIR / 'dev-core' / 'skills' / 'code-review' / 'review-classes.yml'
_DEFAULT_SKILL_PATH = PLUGINS_DIR / 'dev-core' / 'skills' / 'code-review' / 'SKILL.md'

# Anchor in SKILL.md: "Canonical classes (use slug only): <slug1>, ...<slugN>."
_SPAWN_LIST_RE = re.compile(
    r'Canonical classes \(use slug only\):\s+([^.\r\n]+)\.',
)


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


def check_class_list_sync(
    yaml_path: Path = _DEFAULT_YAML_PATH,
    skill_path: Path = _DEFAULT_SKILL_PATH,
) -> list[str]:
    """Inline class list in code-review/SKILL.md spawn template must match review-classes.yml.

    Exit semantics when called from main():
      - errors containing 'not found' or 'parse' → caller returns 2 (IO/parse failure)
      - mismatch errors → caller returns 1 (drift)
    """
    errors = []

    if not yaml_path.exists():
        errors.append(f'review-classes.yml not found at {yaml_path}')
        return errors
    if not skill_path.exists():
        errors.append(f'code-review/SKILL.md not found at {skill_path}')
        return errors

    try:
        with open(yaml_path) as f:
            text = f.read()
    except UnicodeDecodeError as e:
        errors.append(f'review-classes.yml is not valid UTF-8: {e}')
        return errors

    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        errors.append(f'failed to parse review-classes.yml: invalid YAML syntax: {e}')
        return errors

    classes = (data or {}).get('classes', [])
    if not classes:
        errors.append(
            'review-classes.yml contains no class entries — possible parse or schema error'
        )
        return errors

    yaml_slugs = {c['class'] for c in classes if isinstance(c, dict) and 'class' in c}

    try:
        with open(skill_path) as f:
            content = f.read()
    except UnicodeDecodeError as e:
        errors.append(f'code-review/SKILL.md is not valid UTF-8: {e}')
        return errors

    m = _SPAWN_LIST_RE.search(content)
    if not m:
        errors.append('code-review/SKILL.md: canonical class list not found in spawn template')
        return errors

    inline_slugs: set[str] = set()
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


def check_subsumption_pairs(
    yaml_path: Path = _DEFAULT_YAML_PATH,
    skill_path: Path = _DEFAULT_SKILL_PATH,
) -> list[str]:
    """Subsumption pairs declared in review-classes.yml notes must appear together in SKILL.md.

    For each class with a `note:` field, scan the note text for canonical slugs (other than
    the class itself). Every (class_slug, mentioned_slug) pair forms a subsumption pair.
    SKILL.md must reference both members of each pair in close proximity (within the same
    paragraph) so that human readers can find the subsumption rule from either entry point.

    This prevents the failure mode where review-classes.yml says "A subsumes B" but SKILL.md
    only documents the rule under A (or only under B) — leading to one-sided tagging drift.

    Exit semantics when called from main():
      - errors containing 'not found at' or 'parse' or 'not valid utf-8' → caller returns 2
      - mismatch errors → caller returns 1
    """
    errors: list[str] = []

    if not yaml_path.exists():
        errors.append(f'review-classes.yml not found at {yaml_path}')
        return errors
    if not skill_path.exists():
        errors.append(f'code-review/SKILL.md not found at {skill_path}')
        return errors

    try:
        with open(yaml_path) as f:
            text = f.read()
    except UnicodeDecodeError as e:
        errors.append(f'review-classes.yml is not valid UTF-8: {e}')
        return errors

    try:
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        errors.append(f'failed to parse review-classes.yml: invalid YAML syntax: {e}')
        return errors

    classes = (data or {}).get('classes', [])
    if not classes:
        errors.append('review-classes.yml contains no class entries')
        return errors

    yaml_slugs = {c['class'] for c in classes if isinstance(c, dict) and 'class' in c}

    pairs: set[frozenset[str]] = set()
    for c in classes:
        if not isinstance(c, dict):
            continue
        slug = c.get('class')
        note = c.get('note')
        if not slug or not note or not isinstance(note, str):
            continue
        for other in yaml_slugs:
            if other == slug:
                continue
            if re.search(rf'(?<![\w-]){re.escape(other)}(?![\w-])', note):
                pairs.add(frozenset((slug, other)))

    if not pairs:
        return errors

    try:
        with open(skill_path) as f:
            content = f.read()
    except UnicodeDecodeError as e:
        errors.append(f'code-review/SKILL.md is not valid UTF-8: {e}')
        return errors

    paragraphs = re.split(r'\n\s*\n', content)

    for pair in pairs:
        a, b = sorted(pair)
        together = any(
            re.search(rf'(?<![\w-]){re.escape(a)}(?![\w-])', p)
            and re.search(rf'(?<![\w-]){re.escape(b)}(?![\w-])', p)
            for p in paragraphs
        )
        if not together:
            errors.append(
                f'subsumption pair ({a}, {b}) declared in review-classes.yml note '
                f'but not mentioned together in any paragraph of code-review/SKILL.md'
            )

    return errors


def _is_io_error(msg: str) -> bool:
    """Return True when the error message signals an IO/parse failure (exit 2).

    File-not-found messages match 'not found at' (path present).
    Anchor-not-found is drift (exit 1) and does NOT match this filter.
    """
    lower = msg.lower()
    # 'not found at' matches file-missing errors; bare 'not found in' is anchor drift
    if 'not found at' in lower:
        return True
    return any(k in lower for k in ('failed to parse', 'not valid utf-8', 'no class entries'))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Validate plugin structure and data conventions.')
    parser.add_argument(
        '--check',
        choices=['class-list-sync', 'subsumption-pairs'],
        help='Run only the named check (default: run all checks)',
    )
    args = parser.parse_args(argv)

    if args.check == 'class-list-sync':
        errors = check_class_list_sync()
        if errors:
            print('FAIL: Class list sync', file=sys.stderr)
            for e in errors:
                print(f'  {e}', file=sys.stderr)
            # exit 2 for IO/parse failures, 1 for slug drift
            return 2 if any(_is_io_error(e) for e in errors) else 1
        return 0

    if args.check == 'subsumption-pairs':
        errors = check_subsumption_pairs()
        if errors:
            print('FAIL: Subsumption pairs', file=sys.stderr)
            for e in errors:
                print(f'  {e}', file=sys.stderr)
            return 2 if any(_is_io_error(e) for e in errors) else 1
        return 0

    # Default: run all checks
    all_errors = []
    checks = [
        ('Personal data scan', check_personal_data),
        ('Legacy references', check_legacy_refs),
        ('data.root uniqueness', check_data_root_uniqueness),
        ('Example files exist', check_examples_exist),
        ('Vendored paths.py sync', check_vendored_paths),
        ('Tempfile convention', check_tempfile_convention),
        ('Class list sync', check_class_list_sync),
        ('Subsumption pairs', check_subsumption_pairs),
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
