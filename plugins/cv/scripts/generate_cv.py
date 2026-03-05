#!/usr/bin/env python3
"""Generate a CV from structured JSON data using Jinja2 templates."""
import argparse
import json
import sys
from pathlib import Path

try:
    from jinja2 import Environment, FileSystemLoader, select_autoescape
except ImportError:
    print('Error: Jinja2 is required. Install with: pip install jinja2', file=sys.stderr)
    sys.exit(1)

_plugin_root = str(Path(__file__).resolve().parent.parent)
_repo_root = str(Path(__file__).resolve().parents[3])
for _p in [_plugin_root, _repo_root]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

from roxabi_sdk.paths import get_plugin_data, get_config, ensure_dir
from adapters.json_config import JsonConfigLoader
from domain.models import CVConfig
from domain.exceptions import DataError
from use_cases.generate_cv import GenerateCVUseCase

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / 'templates'
_CV_DIR = get_plugin_data('cv')
DEFAULT_DATA = _CV_DIR / 'cv_data.json'
DEFAULT_OUTPUT_DIR = _CV_DIR / 'generated'


def t(value, lang):
    """Translate a field to a target language.

    Returns value[lang] for dict fields, value as-is for plain strings.
    Falls back to first available key if lang is missing from a dict.
    """
    if isinstance(value, dict):
        if lang in value:
            return value[lang]
        fallback = next(iter(value))
        print(f"Warning: lang '{lang}' missing, using '{fallback}'", file=sys.stderr)
        return value[fallback]
    return value


def load_config() -> dict:
    """Load CV plugin config with backward-compat defaults."""
    config_path = get_config('cv')
    if config_path.exists():
        with open(config_path) as f:
            cfg = json.load(f)
    else:
        cfg = {}
    has_lang_keys = 'default_language' in cfg
    cfg.setdefault('default_language', 'en')
    cfg.setdefault('supported_languages', ['en'])
    cfg.setdefault('default_format', 'md')
    if not has_lang_keys:
        print("Warning: 'default_language' missing from cv.json. Run /cv-init to update config.", file=sys.stderr)
    return cfg


def resolve_languages(lang_arg, config):
    """Resolve --lang flag to a list of language codes."""
    supported = config['supported_languages']
    if lang_arg is None:
        return [config['default_language']]
    if lang_arg == 'all':
        return supported
    if lang_arg not in supported:
        print(f"Error: unsupported language '{lang_arg}'. Supported: {', '.join(supported)}", file=sys.stderr)
        sys.exit(1)
    return [lang_arg]


def load_data(path: Path) -> dict:
    """Load and validate CV data from JSON."""
    if not path.exists():
        print(f'Error: data file not found: {path}', file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        data = json.load(f)
    # Support both 'experience' (legacy) and 'experiences' (rich format) — alias either way
    if 'experiences' in data and 'experience' not in data:
        data['experience'] = data['experiences']
    elif 'experience' in data and 'experiences' not in data:
        data['experiences'] = data['experience']
    has_exp = 'experience' in data or 'experiences' in data
    required = ['personal', 'education', 'skills']
    if not has_exp:
        required.append('experience')
    missing = [k for k in required if k not in data]
    if missing:
        print(f'Error: missing required sections in data: {", ".join(missing)}', file=sys.stderr)
        sys.exit(1)
    return data


def render(data: dict, fmt: str, lang: str, template: str = 'cv_template') -> str:
    """Render CV data using the appropriate Jinja2 template."""
    template_name = f'{template}.{fmt}.jinja2'
    template_path = TEMPLATES_DIR / template_name
    if not template_path.exists():
        print(f'Error: template not found: {template_path}', file=sys.stderr)
        sys.exit(1)
    env = Environment(
        loader=FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=select_autoescape(['html']),
        keep_trailing_newline=True,
        trim_blocks=True,
        lstrip_blocks=True
    )
    env.filters['t'] = t
    tmpl = env.get_template(template_name)
    return tmpl.render(**data, lang=lang)


def main():
    # Composition root — construct adapter + use case
    loader = JsonConfigLoader(CVConfig)
    uc = GenerateCVUseCase(config_loader=loader)

    config_path = get_config('cv')
    try:
        config = uc.load_config(config_path)
    except Exception:
        config = CVConfig(default_language='en', default_format='md',
                          supported_languages=('en',))
        print("Warning: 'default_language' missing from cv.json. Run /cv-init to update config.",
              file=sys.stderr)

    parser = argparse.ArgumentParser(description='Generate CV from structured JSON data')
    parser.add_argument('--data', type=Path, default=DEFAULT_DATA,
                        help='Path to cv_data.json')
    parser.add_argument('--output', type=Path, default=None,
                        help='Output file path (ignored when generating multiple files)')
    parser.add_argument('--format', choices=['md', 'html', 'all'],
                        default=config.default_format,
                        help='Output format (default: from config)')
    parser.add_argument('--lang', default=None,
                        help='Language: fr, en, or all (default: from config)')
    parser.add_argument('--template', default='cv_template',
                        help='Template name without extension (default: cv_template, rich: cv_template_rich)')
    args = parser.parse_args()

    try:
        langs = uc.resolve_languages(args.lang, config)
    except DataError as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
    formats = ['md', 'html'] if args.format == 'all' else [args.format]

    data = load_data(args.data)

    for fmt in formats:
        for lang in langs:
            if args.output and len(langs) == 1 and len(formats) == 1:
                output = args.output
            else:
                suffix = f'_{lang}' if len(langs) > 1 else ''
                output = DEFAULT_OUTPUT_DIR / f'cv{suffix}.{fmt}'
            result = render(data, fmt, lang, template=args.template)
            ensure_dir(output.parent)
            output.write_text(result)
            print(f'CV generated: {output}')


if __name__ == '__main__':
    main()
