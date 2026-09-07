"""A *non-terminated* YAML flow collection in SKILL.md frontmatter makes a skill dark.

`argument-hint: [#PR]` is invalid YAML — `#` after `[` opens a comment that eats
the closing `]`, so the sequence never terminates and the scanner consumes every
following key to EOF. The host drops the skill silently: it stays reachable as a
slash command (the OMP extension strips frontmatter as text and never parses it)
while being invisible to the model and to `skill: "<name>"` chaining.

Measured 2026-09-07 on OMP: `R-dev-review` only. `R-adr`'s
`["Title of decision" | --list]` also fails `yaml.safe_load` but loaded fine —
its error is bounded to its own line, so non-termination is the discriminator.
The guard is still total, as hygiene: an unquoted value yields a list where a
string is meant, and is one `#` from non-termination.
"""

import yaml

from tools.validate_plugins import PLUGINS_DIR, check_skill_frontmatter_scalars


def _frontmatter(path):
    text = path.read_text()
    assert text.startswith('---\n'), f'{path} has no frontmatter'
    return text[4 : text.index('\n---\n', 4)]


def test_repo_has_no_unquoted_flow_collection():
    assert check_skill_frontmatter_scalars() == []


def test_every_argument_hint_is_a_string():
    """A closed-but-unquoted `[a | b]` parses as a list, not the intended string."""
    checked = 0
    for skill_md in PLUGINS_DIR.glob('*/skills/**/SKILL.md'):
        for line in _frontmatter(skill_md).splitlines():
            if line.startswith('argument-hint:'):
                value = yaml.safe_load(line)['argument-hint']
                assert isinstance(value, str), f'{skill_md}: argument-hint is {type(value).__name__}'
                checked += 1
    assert checked > 0, 'no argument-hint found — the test would pass vacuously'


def test_detects_the_bracket_hash_shape(tmp_path, monkeypatch):
    """The exact shape that took R-dev-review dark on OMP."""
    skill = tmp_path / 'demo' / 'skills' / 'demo'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text("---\nname: demo\nargument-hint: [#PR]\ndescription: x\n---\n\nbody\n")

    monkeypatch.setattr('tools.validate_plugins.PLUGINS_DIR', tmp_path)
    monkeypatch.setattr('tools.validate_plugins.REPO_ROOT', tmp_path)

    errors = check_skill_frontmatter_scalars()
    assert len(errors) == 1
    assert 'argument-hint' in errors[0]


def test_bracket_hash_consumes_the_whole_frontmatter():
    """Non-termination is the mechanism: the scanner runs to EOF, losing every key.

    A merely *malformed* flow collection fails on its own line and leaves the
    earlier keys standing — that is why `R-adr` loaded while `R-dev-review` did
    not. Pinning the span, not just "it raises", keeps the two apart.
    """
    fatal = 'name: demo\nargument-hint: [#PR]\ndescription: x\nversion: 1.0.0\n'
    bounded = 'name: demo\nargument-hint: ["Title" | --list]\ndescription: x\nversion: 1.0.0\n'

    def error_line(src):
        try:
            yaml.safe_load(src)
        except yaml.YAMLError as exc:
            mark = exc.problem_mark or exc.context_mark
            return mark.line + 1
        raise AssertionError(f'expected {src!r} to fail YAML parsing')

    total = len(fatal.splitlines())
    assert error_line(fatal) == total, 'bracket-hash must consume to EOF'
    assert error_line(bounded) == 2, 'a terminated-but-malformed value stays on its line'


def test_accepts_the_quoted_form(tmp_path, monkeypatch):
    skill = tmp_path / 'demo' / 'skills' / 'demo'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text("---\nname: demo\nargument-hint: '[#PR]'\ndescription: x\n---\n\nbody\n")

    monkeypatch.setattr('tools.validate_plugins.PLUGINS_DIR', tmp_path)
    monkeypatch.setattr('tools.validate_plugins.REPO_ROOT', tmp_path)

    assert check_skill_frontmatter_scalars() == []
