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

from _lib.paths import get_plugin_data, ensure_dir

TEMPLATES_DIR = Path(__file__).resolve().parent.parent / 'templates'
_CV_DIR = get_plugin_data('cv')
DEFAULT_DATA = _CV_DIR / 'cv_data.json'
DEFAULT_OUTPUT_DIR = _CV_DIR / 'generated'


def load_data(path: Path) -> dict:
    """Load and validate CV data from JSON."""
    if not path.exists():
        print(f'Error: data file not found: {path}', file=sys.stderr)
        sys.exit(1)
    with open(path) as f:
        data = json.load(f)
    required = ['personal', 'experience', 'education', 'skills']
    missing = [k for k in required if k not in data]
    if missing:
        print(f'Error: missing required sections in data: {", ".join(missing)}', file=sys.stderr)
        sys.exit(1)
    return data


def render(data: dict, fmt: str) -> str:
    """Render CV data using the appropriate Jinja2 template."""
    template_name = f'cv_template.{fmt}.jinja2'
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
    template = env.get_template(template_name)
    return template.render(**data)


def main():
    parser = argparse.ArgumentParser(description='Generate CV from structured JSON data')
    parser.add_argument('--data', type=Path, default=DEFAULT_DATA,
                        help='Path to cv_data.json')
    parser.add_argument('--output', type=Path, default=None,
                        help='Output file path')
    parser.add_argument('--format', choices=['md', 'html'], default='md',
                        help='Output format (default: md)')
    args = parser.parse_args()

    if args.output is None:
        args.output = DEFAULT_OUTPUT_DIR / f'cv.{args.format}'

    data = load_data(args.data)
    result = render(data, args.format)

    ensure_dir(args.output.parent)
    args.output.write_text(result)
    print(f'CV generated: {args.output}')


if __name__ == '__main__':
    main()
