#!/usr/bin/env python3
"""Assert that the inline class list in code-review/SKILL.md Phase 3 spawn template
matches the canonical slugs in review-classes.yml.

Exit codes:
  0 — in sync
  1 — mismatch (missing and/or extra slugs reported on stderr)
  2 — file not found or parse error
"""

import re
import sys
from pathlib import Path

try:
    import yaml
    _HAVE_YAML = True
except ImportError:
    _HAVE_YAML = False

REPO_ROOT = Path(__file__).resolve().parent.parent
YAML_PATH = REPO_ROOT / 'plugins' / 'dev-core' / 'skills' / 'code-review' / 'review-classes.yml'
SKILL_PATH = REPO_ROOT / 'plugins' / 'dev-core' / 'skills' / 'code-review' / 'SKILL.md'

# Regex-based fallback: matches lines of the form "  - class: <slug>"
_CLASS_LINE_RE = re.compile(r'^\s+-\s+class:\s+(\S+)', re.MULTILINE)

# Anchor in SKILL.md: "Canonical classes (use slug only): <slug1>, <slug2>, ...<slugN>."
_SPAWN_LIST_RE = re.compile(
    r'Canonical classes \(use slug only\):\s+([^.\n]+)\.',
)


def _load_yaml_slugs(path: Path) -> set[str]:
    """Return the set of class slugs from review-classes.yml."""
    text = path.read_text(encoding='utf-8')
    if _HAVE_YAML:
        data = yaml.safe_load(text)
        classes = (data or {}).get('classes', [])
        return {c['class'] for c in classes if isinstance(c, dict) and 'class' in c}
    # Fallback: regex scan for "  - class: <slug>" lines
    return set(_CLASS_LINE_RE.findall(text))


def _load_skill_slugs(path: Path) -> set[str] | None:
    """Return the set of slugs from the SKILL.md Phase 3 spawn template inline list.

    Returns None when the anchor is not found.
    """
    text = path.read_text(encoding='utf-8')
    m = _SPAWN_LIST_RE.search(text)
    if not m:
        return None
    raw = m.group(1)
    return {slug.strip() for slug in raw.split(',') if slug.strip()}


def main() -> int:
    errors: list[str] = []

    if not YAML_PATH.exists():
        print(f'ERROR: review-classes.yml not found at {YAML_PATH}', file=sys.stderr)
        return 2
    if not SKILL_PATH.exists():
        print(f'ERROR: code-review/SKILL.md not found at {SKILL_PATH}', file=sys.stderr)
        return 2

    try:
        yaml_slugs = _load_yaml_slugs(YAML_PATH)
    except Exception as exc:
        print(f'ERROR: failed to parse {YAML_PATH}: {exc}', file=sys.stderr)
        return 2

    skill_slugs = _load_skill_slugs(SKILL_PATH)
    if skill_slugs is None:
        print(
            'ERROR: canonical class list not found in SKILL.md spawn template.\n'
            '  Expected pattern: "Canonical classes (use slug only): <slug1>, ...<slugN>."',
            file=sys.stderr,
        )
        return 2

    missing = yaml_slugs - skill_slugs
    extra = skill_slugs - yaml_slugs

    if missing:
        errors.append(
            f'missing in SKILL.md spawn template (present in review-classes.yml): {sorted(missing)}'
        )
    if extra:
        errors.append(
            f'extra in SKILL.md spawn template (absent from review-classes.yml): {sorted(extra)}'
        )

    if errors:
        print('FAIL: taxonomy-spawn-template-sync', file=sys.stderr)
        for e in errors:
            print(f'  {e}', file=sys.stderr)
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
