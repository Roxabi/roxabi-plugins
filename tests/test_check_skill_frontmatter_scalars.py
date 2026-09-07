"""An unquoted YAML flow collection in SKILL.md frontmatter makes the skill dark.

`argument-hint: [#PR]` is invalid YAML — `#` after `[` opens a comment, the flow
sequence never closes, and the scanner swallows every following key. The host
drops the skill silently: it stays reachable as a slash command (the OMP
extension strips frontmatter as text and never parses it) while being invisible
to the model and to `skill: "<name>"` chaining.
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
    """The exact shape that took R-adr, R-dev-review and issue-triage dark."""
    skill = tmp_path / 'demo' / 'skills' / 'demo'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text("---\nname: demo\nargument-hint: [#PR]\ndescription: x\n---\n\nbody\n")

    monkeypatch.setattr('tools.validate_plugins.PLUGINS_DIR', tmp_path)
    monkeypatch.setattr('tools.validate_plugins.REPO_ROOT', tmp_path)

    errors = check_skill_frontmatter_scalars()
    assert len(errors) == 1
    assert 'argument-hint' in errors[0]

    # and the frontmatter really is unparseable, which is why it must be caught
    try:
        yaml.safe_load('name: demo\nargument-hint: [#PR]\ndescription: x\n')
    except yaml.YAMLError:
        pass
    else:
        raise AssertionError('expected the unquoted flow sequence to fail YAML parsing')


def test_accepts_the_quoted_form(tmp_path, monkeypatch):
    skill = tmp_path / 'demo' / 'skills' / 'demo'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text("---\nname: demo\nargument-hint: '[#PR]'\ndescription: x\n---\n\nbody\n")

    monkeypatch.setattr('tools.validate_plugins.PLUGINS_DIR', tmp_path)
    monkeypatch.setattr('tools.validate_plugins.REPO_ROOT', tmp_path)

    assert check_skill_frontmatter_scalars() == []
