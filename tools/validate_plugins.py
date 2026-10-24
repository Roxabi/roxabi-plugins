#!/usr/bin/env python3
"""Validate plugin structure and data conventions.

Checks:
- No personal data in plugin source files
- No references to memory.db (legacy)
- No references to _shared/ (2ndBrain legacy)
- data.root is unique across all plugin.json files (never metadata.json)
- No leftover .claude-plugin/metadata.json (data.* lives in plugin.json)
- Example files referenced in plugin.json exist
- Fixed /tmp/ literals in active SKILL.md files
- review-classes.yml is readable UTF-8, valid YAML, and has class entries
- Catalogued `.claude-plugin/marketplace.json` plugin names appear in root
  `README.md` (link-only plugins are exempt)


Usage:
  python3 tools/validate_plugins.py                     # run all checks
  python3 tools/validate_plugins.py --check review-catalogue   # run only review-catalogue
"""
import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
PLUGINS_DIR = REPO_ROOT / 'plugins'
# Link-only plugins ship via `omp plugin link` only, so they are never catalog rows and are not
# required in README.md. Empty today: omp-build now ships as a versioned `.omp-plugin/` catalog row.
LINK_ONLY_PLUGIN_NAMES = frozenset()
MARKETPLACE_JSON = REPO_ROOT / '.claude-plugin' / 'marketplace.json'
OMP_MARKETPLACE_JSON = REPO_ROOT / '.omp-plugin' / 'marketplace.json'
README_MD = REPO_ROOT / 'README.md'



_DEFAULT_YAML_PATH = PLUGINS_DIR / 'omp-build' / 'skills' / 'dev-review' / 'review-classes.yml'


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


def check_no_metadata_json() -> list[str]:
    """Fail if any plugin still ships .claude-plugin/metadata.json.

    data.* (and vault) belong in plugin.json only.
    """
    errors = []
    for meta in sorted(PLUGINS_DIR.glob('*/.claude-plugin/metadata.json')):
        plugin_name = meta.parent.parent.name
        errors.append(
            f'{plugin_name}: .claude-plugin/metadata.json is forbidden; '
            f'declare data.* in plugin.json'
        )
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


def check_tempfile_convention() -> list[str]:
    """SKILL.md files must not hardcode /tmp/<name> literals.

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


def check_skill_frontmatter_scalars() -> list[str]:
    """SKILL.md frontmatter must not open an unquoted YAML flow collection.

    `argument-hint: [#PR]` is invalid YAML: `#` after `[` opens a comment, which
    eats the closing `]`, so the flow sequence never terminates and the scanner
    consumes every following key to EOF. The whole frontmatter is lost and the
    host drops the skill *silently* — it stays invocable as a slash command (the
    OMP extension strips frontmatter as text, never parsing it) while being
    invisible to the model and to `skill: "<name>"` chaining.

    Measured 2026-09-07 on OMP: `R-dev-review` was dark this way. That is the
    only attributable case. Two facts bound the claim:

    - `R-adr` carried `argument-hint: ["Title of decision" | --list]`, which also
      fails `yaml.safe_load`, yet it loaded fine. Its error is bounded to its own
      line (`found character '|'`) instead of running to EOF, so the discriminator
      is **non-termination**, not "invalid flow collection".
    - `issue-triage` is not installed on OMP, so its absence from the skill list
      is explained by that, not by this defect.

    The invariant stays total anyway, as hygiene rather than as an evidenced fix:
    a closed-but-unquoted `[a | b]` parses as a *list* where a string is intended,
    and is one `#` away from non-termination. Quote it.

    Scope: measured on OMP only. Not verified on Claude / Codex / Grok.
    """
    errors = []
    flow_open = re.compile(r'^([A-Za-z0-9_-]+):\s*([\[{].*)$')

    for skill_md in sorted(PLUGINS_DIR.glob('*/skills/**/SKILL.md')):
        plugin_name = skill_md.relative_to(PLUGINS_DIR).parts[0]
        try:
            text = skill_md.read_text()
        except UnicodeDecodeError as e:
            errors.append(f'{plugin_name}: {skill_md.relative_to(REPO_ROOT)} is not valid UTF-8: {e}')
            continue
        if not text.startswith('---\n'):
            continue
        end = text.find('\n---\n', 4)
        if end == -1:
            errors.append(
                f'{plugin_name}: {skill_md.relative_to(REPO_ROOT)} frontmatter is never closed'
            )
            continue

        rel = skill_md.relative_to(REPO_ROOT)
        for offset, line in enumerate(text[4:end].splitlines()):
            match = flow_open.match(line)
            if match:
                errors.append(
                    f'{plugin_name}: unquoted flow collection at {rel}:{offset + 2} '
                    f'→ {match.group(1)}: quote the value '
                    f"(e.g. {match.group(1)}: '{match.group(2).strip()}')"
                )
    return errors


def check_review_catalogue(
    yaml_path: Path = _DEFAULT_YAML_PATH,
) -> list[str]:
    """The canonical review catalogue must be readable, parseable, and non-empty."""
    errors: list[str] = []

    if not yaml_path.exists():
        errors.append(f'review-classes.yml not found at {yaml_path}')
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




def check_marketplace_readme_catalog(
    marketplace_path=None,
    readme_path=None,
    link_only=None,
) -> list[str]:
    """marketplace.json plugin names must appear in README.md.

    Names in LINK_ONLY_PLUGIN_NAMES (empty today) are excluded: a link-only plugin
    ships via `omp plugin link`, so it is never a catalog row even though it exists
    on disk. Only `.claude-plugin/marketplace.json` is read — an OMP-only plugin
    (`omp-build`) is catalogued in `.omp-plugin/marketplace.json` alone.
    """
    errors = []
    if marketplace_path is None:
        marketplace_path = MARKETPLACE_JSON
    if readme_path is None:
        readme_path = README_MD
    if link_only is None:
        link_only = LINK_ONLY_PLUGIN_NAMES
    marketplace_path = Path(marketplace_path)
    readme_path = Path(readme_path)

    if not marketplace_path.is_file():
        return [f'marketplace.json not found at {marketplace_path}']
    if not readme_path.is_file():
        return [f'README.md not found at {readme_path}']

    try:
        data = json.loads(marketplace_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as e:
        return [f'failed to parse marketplace.json: {e}']

    plugins = data.get('plugins', [])
    if not isinstance(plugins, list):
        return ['failed to parse marketplace.json: plugins is not a list']

    try:
        readme = readme_path.read_text(encoding='utf-8')
    except OSError as e:
        return [f'failed to parse README.md: {e}']

    for plugin in plugins:
        if not isinstance(plugin, dict):
            continue
        name = plugin.get('name')
        if not name or name in link_only:
            continue
        if name not in readme:
            errors.append(
                f'{name}: catalogued in marketplace.json but missing from README.md'
            )
    return errors


def _strip_dot_slash(path_text: str) -> str:
    text = path_text.strip()
    while text.startswith('./'):
        text = text[2:]
    return text


def catalog_source_in_archive(source: str, repo_root: Path) -> bool:
    """True when a local catalog path lands under archived/.

    Spec A / #805: refuse the inert archive as an installable source. Lexical
    collapse catches `./plugins/../archived/…`; resolve catches a symlink whose
    final target is under archived/. Accepts `./…`, `archived/…`, and other
    repo-relative spellings (not only the `./` prefix).
    """
    if not isinstance(source, str) or not source.strip():
        return False
    text = source.strip()
    if '://' in text:
        return False  # remote URL — not a local archive path
    relative_text = _strip_dot_slash(text)
    lexical = Path(os.path.normpath(relative_text))
    if lexical.parts and lexical.parts[0] == 'archived':
        return True
    candidate = repo_root / relative_text
    if not candidate.exists():
        return False
    try:
        relative = candidate.resolve().relative_to(repo_root.resolve())
    except ValueError:
        return False
    return bool(relative.parts) and relative.parts[0] == 'archived'


def catalog_row_local_paths(row: dict, metadata: dict | None = None) -> list[str]:
    """Local path spellings a catalog row can use to reach archive content."""
    paths: list[str] = []
    source = row.get('source')
    plugin_root = metadata.get('pluginRoot') if isinstance(metadata, dict) else None
    if isinstance(source, str):
        paths.append(source)
        # Bare plugin names resolve under metadata.pluginRoot on Claude catalogs.
        if (
            isinstance(plugin_root, str)
            and plugin_root.strip()
            and '/' not in source
            and not source.startswith('.')
            and '://' not in source
        ):
            paths.append(str(Path(plugin_root) / source))
            paths.append(plugin_root)
    elif isinstance(source, dict):
        nested = source.get('path')
        if isinstance(nested, str) and nested.strip():
            paths.append(nested)
    return paths


def check_catalog_archived_sources(catalog_path=None, repo_root=None, label='catalog') -> list[str]:
    """Refuse marketplace rows whose local source resolves under archived/."""
    catalog_path = Path(catalog_path) if catalog_path is not None else OMP_MARKETPLACE_JSON
    repo_root = Path(repo_root) if repo_root is not None else REPO_ROOT
    if not catalog_path.is_file():
        return [f'{label} marketplace.json not found at {catalog_path}']
    try:
        data = json.loads(catalog_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as e:
        return [f'failed to parse {label} marketplace.json: {e}']
    plugins = data.get('plugins') if isinstance(data, dict) else None
    if not isinstance(plugins, list):
        return [f'failed to parse {label} marketplace.json: plugins is not a list']
    metadata = data.get('metadata') if isinstance(data, dict) else None
    errors = []
    for row in plugins:
        if not isinstance(row, dict):
            continue
        name = row.get('name') or '<unnamed>'
        for path_text in catalog_row_local_paths(row, metadata if isinstance(metadata, dict) else None):
            if catalog_source_in_archive(path_text, repo_root):
                display = row.get('source')
                display_text = path_text if not isinstance(display, dict) else path_text
                errors.append(
                    f'{name}: {label} catalog source {display_text} points at archived/; '
                    f'archives are not installable'
                )
                break
    return errors


def check_omp_catalog(catalog_path=None, repo_root=None) -> list[str]:
    """The OMP catalog must parse, point at real plugin dirs, and carry the package version.

    OMP keys a marketplace install's cache on the catalog row's `version`, not on
    `package.json` (#568): a bump written in one file only ships new content under
    the old key, and `omp plugin upgrade` sees nothing. A version declared on one
    side only is the same drift. Invalid JSON rejects every row of the catalog at once.
    Rows whose plugin dir has no `package.json` have nothing to compare against.
    """
    catalog_path = Path(catalog_path) if catalog_path is not None else OMP_MARKETPLACE_JSON
    repo_root = Path(repo_root) if repo_root is not None else REPO_ROOT

    if not catalog_path.is_file():
        return [f'OMP marketplace.json not found at {catalog_path}']
    try:
        data = json.loads(catalog_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as e:
        return [f'failed to parse OMP marketplace.json: {e}']
    plugins = data.get('plugins') if isinstance(data, dict) else None
    if not isinstance(plugins, list):
        return ['failed to parse OMP marketplace.json: plugins is not a list']

    errors = []
    for row in plugins:
        name = row.get('name') if isinstance(row, dict) else None
        if not name:
            errors.append(f'OMP catalog row without a name: {row!r}')
            continue
        # Spec A / #805: refuse archived installs for every local spelling
        # (bare archived/…, git-subdir.path), not only the `./…` package-compare path.
        archived_hit = False
        for path_text in catalog_row_local_paths(row, None):
            if catalog_source_in_archive(path_text, repo_root):
                errors.append(
                    f'{name}: OMP catalog source {path_text} points at archived/; '
                    f'archives are not installable'
                )
                archived_hit = True
                break
        if archived_hit:
            continue
        source = row.get('source')
        if not isinstance(source, str) or not source.startswith('./'):
            continue  # a remote source has no local package to compare
        plugin_dir = repo_root / source
        if not plugin_dir.is_dir():
            errors.append(f'{name}: OMP catalog source {source} is not a directory')
            continue
        package_json = plugin_dir / 'package.json'
        if not package_json.is_file():
            continue
        try:
            package = json.loads(package_json.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError) as e:
            errors.append(f'{name}: failed to parse {source}/package.json: {e}')
            continue
        catalog_version = row.get('version')
        package_version = package.get('version') if isinstance(package, dict) else None
        if catalog_version != package_version:
            errors.append(
                f'{name}: OMP catalog version {catalog_version!r} does not match '
                f'{source}/package.json version {package_version!r} — OMP keys its cache on the catalog version'
            )
    return errors


def check_claude_catalog_archived_sources(catalog_path=None, repo_root=None) -> list[str]:
    """Claude marketplace rows must not reinstall archived/ sources (Spec A / #805)."""
    return check_catalog_archived_sources(
        catalog_path if catalog_path is not None else MARKETPLACE_JSON,
        repo_root,
        label='Claude',
    )




def _is_io_error(msg: str) -> bool:
    """Return True when the error message signals an IO/parse failure (exit 2)."""
    lower = msg.lower()
    if 'not found at' in lower:
        return True
    return any(k in lower for k in ('failed to parse', 'not valid utf-8', 'no class entries'))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Validate plugin structure and data conventions.')
    parser.add_argument(
        '--check',
        choices=['review-catalogue'],
        help='Run only the named check (default: run all checks)',
    )
    args = parser.parse_args(argv)

    if args.check == 'review-catalogue':
        errors = check_review_catalogue()
        if errors:
            print('FAIL: Review catalogue', file=sys.stderr)
            for e in errors:
                print(f'  {e}', file=sys.stderr)
            return 2 if any(_is_io_error(e) for e in errors) else 1
        return 0

    all_errors = []
    checks = [
        ('Personal data scan', check_personal_data),
        ('Legacy references', check_legacy_refs),
        ('data.root uniqueness', check_data_root_uniqueness),
        ('No metadata.json', check_no_metadata_json),
        ('Example files exist', check_examples_exist),
        ('Tempfile convention', check_tempfile_convention),
        ('SKILL.md frontmatter scalars', check_skill_frontmatter_scalars),
        ('Review catalogue', check_review_catalogue),
        ('Marketplace README catalog', check_marketplace_readme_catalog),
        ('OMP catalog versions', check_omp_catalog),
        ('Claude catalog archived sources', check_claude_catalog_archived_sources),
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
