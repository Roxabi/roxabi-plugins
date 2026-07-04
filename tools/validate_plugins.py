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
- Budgeted SKILL.md files stay within their physical line budgets
- Gated dev-core legend lines are one-line pointers to the canonical notation
  glossary, and compress's inline whitelist stays set-equal to its core table
- Golden compressed artifacts stay inventory-equivalent to their expected
  inventories (compress read-back goldens, issue #311)

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

# Plugin name → max physical lines of its skills/*/SKILL.md (issue #309 Decision 5)
SKILL_LINE_BUDGETS = {'compress': 110}

# Notation-legends check (issue #310 Decision 9): gated legend files must carry a
# one-line pointer to the canonical glossary, whose core table must stay set-equal
# to the compress whitelist.
NOTATION_LEGEND_FILES = [
    PLUGINS_DIR / 'dev-core' / 'skills' / 'shared' / 'references' / 'base.md',
    PLUGINS_DIR / 'dev-core' / 'agents' / 'doc-writer.md',
]
NOTATION_GLOSSARY = PLUGINS_DIR / 'shared' / 'references' / 'notation.md'
COMPRESS_SKILL = PLUGINS_DIR / 'compress' / 'skills' / 'compress' / 'SKILL.md'

# Golden read-back triples (issue #311 Decision 6)
GOLDEN_DIR = PLUGINS_DIR / 'compress' / 'skills' / 'compress' / 'references' / 'golden'

# Inventory anchor on its own line: <!-- INV-<category>-<n> -->
_INV_ANCHOR_RE = re.compile(r'^\s*<!--\s*(INV-[a-z]+-\d+)\s*-->\s*$')

# Decision-6 charset: normalized keys keep only [a-z0-9 ∀∃∄∈∉∧∨¬→⟺∅≥≤]
_INV_NORM_DROP_RE = re.compile(r'[^a-z0-9∀∃∄∈∉∧∨¬→⟺∅≥≤]')

_BACKTICK_SPAN_RE = re.compile(r'`([^`]+)`')

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


def check_shared_sources_sync(manifest_path=None, biome_path=None, _copy_sync_prefix=None) -> list[str]:
    """Generated copies in shared-sources.json must match their canonical sources.

    Mirrors tools/sync-shared.ts --check semantics:
    - Strip the 2-line generated header (line 1 = @generated comment, line 2 = blank line)
      from each target and compare the remainder against the canonical file byte-for-byte.
    - Missing target files are also flagged as drift.
    - Asserts that biome.json's copy-sync suppression override includes is set-equal to manifest targets.
    """
    errors = []
    manifest_path = Path(manifest_path) if manifest_path is not None else (REPO_ROOT / 'tools' / 'shared-sources.json')
    biome_path = Path(biome_path) if biome_path is not None else (REPO_ROOT / 'biome.json')

    if not manifest_path.exists():
        errors.append(f'shared-sources.json not found at {manifest_path}')
        return errors

    with open(manifest_path) as f:
        manifest = json.load(f)

    for entry in manifest:
        canonical_rel = entry.get('canonical', '')
        targets = entry.get('targets', [])
        canonical_path = REPO_ROOT / canonical_rel
        if not canonical_path.resolve().is_relative_to(REPO_ROOT.resolve()):
            errors.append(f'Refusing path outside repo: {canonical_rel}')
            continue
        if not canonical_path.exists():
            errors.append(
                f'Canonical source not found: {canonical_rel}'
            )
            continue
        canonical_content = canonical_path.read_text(encoding='utf-8')

        for target_rel in targets:
            target_path = REPO_ROOT / target_rel
            if not target_path.resolve().is_relative_to(REPO_ROOT.resolve()):
                errors.append(f'Refusing path outside repo: {target_rel}')
                continue
            if not target_path.exists():
                errors.append(
                    f'{target_rel} is missing. Run: bun run sync:shared'
                )
                continue
            target_content = target_path.read_text(encoding='utf-8')
            # HEADER CONTRACT: the 2-line @generated header stripped here MUST stay
            # byte-identical to tools/sync-shared.ts::makeHeader() (line 1 = @generated
            # comment, line 2 = blank). If makeHeader changes the header shape/length,
            # update this strip (lines[2:]) in lockstep, or byte-equality will false-fail.
            lines = target_content.split('\n')
            # Header is 2 lines: index 0 = @generated, index 1 = blank; body starts at index 2
            body = '\n'.join(lines[2:]) if len(lines) > 2 else ''
            if body != canonical_content:
                errors.append(
                    f'{target_rel} is out of sync with {canonical_rel}. Run: bun run sync:shared'
                )

    # Biome-vs-manifest set-equality assertion
    if not biome_path.exists():
        errors.append(f'biome.json not found at {biome_path}')
        return errors

    with open(biome_path) as f:
        biome_data = json.load(f)

    # Locate the unique copy-sync suppression override: the entry in biome['overrides']
    # whose includes are all under plugins/dev-init/skills/shared/ (the generated-copy
    # override). Blindly indexing overrides[0] would silently pick the wrong override if the
    # array is reordered or a new override is inserted before it.
    # _copy_sync_prefix is injectable for tests (unit tests use scratch paths outside the
    # canonical plugins/dev-init/ directory).
    overrides = biome_data.get('overrides', [])
    _dev_init_shared_prefix = _copy_sync_prefix if _copy_sync_prefix is not None else 'plugins/dev-init/skills/shared/'

    def _is_copy_sync_override(entry: dict) -> bool:
        includes = entry.get('includes', [])
        return bool(includes) and all(
            str(inc).startswith(_dev_init_shared_prefix) for inc in includes
        )

    manifest_targets = [t for entry in manifest for t in entry.get('targets', [])]

    if manifest_targets:
        # Only assert when the manifest is non-empty (no manifest targets → nothing to check)
        matching = [o for o in overrides if _is_copy_sync_override(o)]
        if len(matching) == 0:
            errors.append(
                'biome.json: could not locate the unique copy-sync suppression override '
                f'(entry whose includes are all under {_dev_init_shared_prefix})'
            )
            return errors
        if len(matching) > 1:
            errors.append(
                'biome.json: could not locate the unique copy-sync suppression override '
                f'(entry whose includes are all under {_dev_init_shared_prefix}) — '
                f'found {len(matching)} matching overrides, expected exactly 1'
            )
            return errors
        biome_includes = matching[0].get('includes', [])
    else:
        # Empty manifest — fall back to overrides[0] for the biome check (nothing to compare)
        biome_includes = overrides[0].get('includes', []) if overrides else []

    biome_set = set(biome_includes)
    manifest_set = set(manifest_targets)

    for path in sorted(manifest_set - biome_set):
        errors.append(
            f'biome.json overrides[0].includes is missing copy-sync target: {path}. Run: derive biome includes from tools/shared-sources.json'
        )
    for path in sorted(biome_set - manifest_set):
        errors.append(
            f'biome.json overrides[0].includes has non-manifest entry: {path}. Either add it to tools/shared-sources.json or remove it from biome.json'
        )

    return errors


def check_skill_line_budget(budgets=None, plugins_dir=None) -> list[str]:
    """Budgeted plugins' SKILL.md files must not exceed their line budgets.

    Budgets are keyed by plugin name — this assumes one budgeted SKILL.md per
    plugin; every skills/*/SKILL.md under a budgeted plugin is held to the
    same cap. A budgeted plugin with no SKILL.md is skipped (not an error).
    """
    errors = []
    if budgets is None:
        budgets = SKILL_LINE_BUDGETS
    if plugins_dir is None:
        plugins_dir = PLUGINS_DIR
    plugins_dir = Path(plugins_dir)
    for plugin_name, budget in sorted(budgets.items()):
        for skill_md in sorted(plugins_dir.glob(f'{plugin_name}/skills/*/SKILL.md')):
            actual = len(skill_md.read_text(encoding='utf-8').splitlines())
            if actual > budget:
                rel = skill_md.relative_to(plugins_dir)
                errors.append(
                    f'{plugin_name}: {rel} is {actual} lines (budget {budget})'
                )
    return errors


def check_notation_legends(legend_files=None, skill_path=None, glossary_path=None) -> list[str]:
    """Gated legend lines must point at notation.md; whitelist ≡ core table.

    Two gates (issue #310 Decision 9):
    - Pointer gate: each gated dev-core file carries exactly one line containing
      'notation.md' — the one-line pointer replacing its former inline legend.
    - Set-equality gate: backtick spans of compress SKILL.md's 'Whitelist:' line
      must be set-equal to the column-1 backtick spans of notation.md's active
      core-table rows ('## Core Table' up to the next '##' heading, cell-1
      '\\|' escapes unescaped). Separator rows (e.g. '|---|:---:|') are inert
      by construction — column 1 of a separator row carries no backtick spans,
      so the column-1 extraction naturally contributes nothing; no explicit
      skip is needed. Both sets must be non-empty so an empty ≡ empty
      comparison never vacuously passes.

    Exit semantics when called from main():
      - errors containing 'not found at' (missing file) → caller returns 2
      - errors containing 'not valid utf-8' (decode failure) → caller returns 2
      - pointer/set drift (incl. missing anchors) → caller returns 1
    """
    errors = []
    if legend_files is None:
        legend_files = NOTATION_LEGEND_FILES
    if skill_path is None:
        skill_path = COMPRESS_SKILL
    if glossary_path is None:
        glossary_path = NOTATION_GLOSSARY
    skill_path = Path(skill_path)
    glossary_path = Path(glossary_path)

    # Gate (a): one-line pointers in the gated legend files
    for legend in legend_files:
        legend = Path(legend)
        if not legend.exists():
            errors.append(f'gated legend file not found at {legend}')
            continue
        try:
            legend_text = legend.read_text(encoding='utf-8')
        except UnicodeDecodeError as e:
            errors.append(f'{legend} is not valid UTF-8: {e}')
            continue
        pointer_lines = [
            line for line in legend_text.splitlines()
            if 'notation.md' in line
        ]
        if not pointer_lines:
            errors.append(
                f'{legend}: legend is not a one-line pointer — '
                f'no line references notation.md'
            )
        elif len(pointer_lines) > 1:
            errors.append(
                f'{legend}: expected exactly one pointer line referencing '
                f'notation.md, found {len(pointer_lines)}'
            )

    # Gate (b): whitelist ≡ core-table active rows
    whitelist: set[str] = set()
    if not skill_path.exists():
        errors.append(f'compress SKILL.md not found at {skill_path}')
    else:
        try:
            skill_text = skill_path.read_text(encoding='utf-8')
        except UnicodeDecodeError as e:
            errors.append(f'{skill_path} is not valid UTF-8: {e}')
        else:
            wl_lines = [
                line for line in skill_text.splitlines()
                if line.startswith('Whitelist:')
            ]
            if not wl_lines:
                errors.append(f'{skill_path}: no line starting "Whitelist:" found')
            else:
                whitelist = set(_BACKTICK_SPAN_RE.findall(wl_lines[0]))
                if not whitelist:
                    errors.append(
                        f'{skill_path}: Whitelist: line carries no backtick spans'
                    )

    core: set[str] = set()
    if not glossary_path.exists():
        errors.append(f'notation glossary not found at {glossary_path}')
    else:
        try:
            glossary_text = glossary_path.read_text(encoding='utf-8')
        except UnicodeDecodeError as e:
            errors.append(f'{glossary_path} is not valid UTF-8: {e}')
        else:
            lines = glossary_text.splitlines()
            in_section = False
            anchor_seen = False
            for line in lines:
                if line.startswith('## '):
                    in_section = line.strip() == '## Core Table'
                    anchor_seen = anchor_seen or in_section
                    continue
                if not in_section or not line.lstrip().startswith('|'):
                    continue
                cells = re.split(r'(?<!\\)\|', line)
                if len(cells) < 2:
                    continue
                for span in _BACKTICK_SPAN_RE.findall(cells[1]):
                    core.add(span.replace('\\|', '|'))
            if not anchor_seen:
                errors.append(
                    f'{glossary_path}: core table anchor "## Core Table" not found in file'
                )
            elif not core:
                errors.append(
                    f'{glossary_path}: core table has no active glyph rows — '
                    f'empty set would vacuously pass'
                )
    # Header row ('| glyph | ...') carries no backtick spans, so it never
    # contributes; only glyph rows populate the set.

    if whitelist and core:
        missing = whitelist - core
        extra = core - whitelist
        if missing:
            errors.append(
                f'whitelist glyphs missing from the notation.md core table: {sorted(missing)}'
            )
        if extra:
            errors.append(
                f'core-table glyphs missing from the SKILL.md whitelist: {sorted(extra)}'
            )
    return errors


def _normalize_inventory_text(text: str) -> str:
    """Decision-6 text-key normalization (issue #311).

    lowercase → strip leading/trailing whitespace → collapse internal
    whitespace runs to one space → drop characters outside the
    `[a-z0-9 ∀∃∄∈∉∧∨¬→⟺∅≥≤]` class (punctuation-only tokens vanish).
    """
    # lockstep: keep identical to plugins/compress/scripts/inventory_diff.py::normalize
    # (Decision-6 charset parity) — see #311
    tokens = []
    for token in text.lower().split():
        token = _INV_NORM_DROP_RE.sub('', token)
        if token:
            tokens.append(token)
    return ' '.join(tokens)


def _parse_compressed_anchors(text: str) -> set[tuple[str, str]]:
    """Extract (anchor, normalized text key) pairs from a compressed artifact.

    Each anchor sits on its own line; its item is the next non-empty line
    (grammar: compress skill references/verify.md).
    """
    pairs = set()
    lines = text.splitlines()
    for lineno, line in enumerate(lines):
        m = _INV_ANCHOR_RE.match(line)
        if not m:
            continue
        item_text = ''
        for follower in lines[lineno + 1:]:
            if follower.strip():
                item_text = follower.strip()
                break
        pairs.add((m.group(1), _normalize_inventory_text(item_text)))
    return pairs


def check_golden_inventories(golden_dir=None) -> list[str]:
    """Golden compressed artifacts must be inventory-equivalent to their JSONs.

    For each `NN-name.compressed.md` in the golden dir, set-compare its
    (anchor, normalized text key) pairs against the sibling
    `NN-name.inventory.json` — both directions, never bytes, no LLM.

    Activation semantic: a MISSING golden dir returns [] (the check is inert
    until the goldens land — their commit activates the gate); an EXISTING
    dir with zero triples is a loud error, never a silent pass.
    """
    errors = []
    golden_dir = Path(golden_dir) if golden_dir is not None else GOLDEN_DIR
    if not golden_dir.exists():
        return errors
    compressed_files = sorted(golden_dir.glob('*.compressed.md'))
    if not compressed_files:
        errors.append(f'no golden triples found in {golden_dir} — empty golden dir')
        return errors

    for compressed in compressed_files:
        triple = compressed.name.removesuffix('.compressed.md')
        inventory_path = golden_dir / f'{triple}.inventory.json'
        if not inventory_path.exists():
            errors.append(f'{triple}: expected inventory not found at {inventory_path}')
            continue
        try:
            with open(inventory_path, encoding='utf-8') as f:
                expected_items = json.load(f)
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            errors.append(f'{triple}: failed to parse {inventory_path.name}: {e}')
            continue

        actual = _parse_compressed_anchors(compressed.read_text(encoding='utf-8'))
        expected = {
            (item['anchor'], _normalize_inventory_text(item['text']))
            for item in expected_items
        }
        for anchor, key in sorted(expected - actual):
            errors.append(
                f'{triple}: inventory item missing from compressed artifact: '
                f'{anchor} ("{key}")'
            )
        for anchor, key in sorted(actual - expected):
            errors.append(
                f'{triple}: compressed anchor not matching expected inventory: '
                f'{anchor} ("{key}")'
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
        choices=['class-list-sync', 'subsumption-pairs', 'shared-sources-sync', 'notation-legends'],
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

    if args.check == 'shared-sources-sync':
        errors = check_shared_sources_sync()
        if errors:
            print('FAIL: Shared sources sync', file=sys.stderr)
            for e in errors:
                print(f'  {e}', file=sys.stderr)
            return 2 if any(_is_io_error(e) for e in errors) else 1
        return 0

    if args.check == 'notation-legends':
        errors = check_notation_legends()
        if errors:
            print('FAIL: Notation legends', file=sys.stderr)
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
        ('Shared sources sync', check_shared_sources_sync),
        ('SKILL.md line budget', check_skill_line_budget),
        ('Notation legends', check_notation_legends),
        ('Golden inventories', check_golden_inventories),
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
