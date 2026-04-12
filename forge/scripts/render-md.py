#!/usr/bin/env -S uv run --script --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "markdown>=3.5",
#     "pymdown-extensions>=10.0",
# ]
# ///
"""render-md.py — render a markdown doc to a themed, self-contained preview HTML.

Drops a `<source>.preview.html` next to the source markdown. The preview loads
mermaid.js from CDN and is styled in the roxabi dark aesthetic so diagrams,
tables, task lists, and code fences all render properly — exactly what the
source will look like when viewed on GitHub, Obsidian, or VS Code.

Usage:
  render-md.py <input.md>                       # → <input>.preview.html next to source
  render-md.py <input.md> -o <output.html>      # explicit output path
  render-md.py                                  # defaults to $FORGE_DIR/roxabi-site/visuals/new-shape-of-tools.md

Env:
  FORGE_DIR    root of the forge data dir (default: ~/.roxabi/forge)

Extensions enabled: tables, fenced_code, codehilite, toc, sane_lists,
pymdownx.tasklist (checkbox lists), pymdownx.superfences (mermaid blocks).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import markdown

FORGE_DIR = Path(os.environ.get("FORGE_DIR", Path.home() / ".roxabi" / "forge"))
DEFAULT_INPUT = FORGE_DIR / "roxabi-site" / "visuals" / "new-shape-of-tools.md"

# ══════════════════════════════════════════════════════════════════
# HTML shell — roxabi dark aesthetic, inlined styles, mermaid CDN
# ══════════════════════════════════════════════════════════════════

SHELL = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — preview</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700;800;900&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
<style>
:root {{
  --bg:      #111210;
  --surface: #1a1b18;
  --border:  #2e3028;
  --text:    #f0ede6;
  --muted:   #c9c4b8;
  --dim:     #8a8577;
  --accent:  #f0b429;
  --info:    #60a5fa;
  --success: #34d399;
  --error:   #f87171;
}}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; padding: 0; }}
body {{
  background: var(--bg);
  color: var(--text);
  font-family: 'Inter', system-ui, sans-serif;
  line-height: 1.65;
  font-size: 16px;
}}
.preview-banner {{
  position: sticky; top: 0; z-index: 100;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  padding: 0.5rem 1rem;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  color: var(--dim);
  letter-spacing: 0.06em;
  text-transform: uppercase;
}}
.preview-banner strong {{ color: var(--accent); }}
main {{
  max-width: 820px;
  margin: 0 auto;
  padding: 2.5rem 1.75rem 5rem;
}}
h1, h2, h3, h4 {{
  color: var(--text);
  font-weight: 800;
  letter-spacing: -0.02em;
  line-height: 1.2;
}}
h1 {{
  font-size: 2.1rem;
  font-weight: 900;
  letter-spacing: -0.035em;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0.5rem;
  margin: 0 0 1.25rem;
}}
h2 {{
  font-size: 1.5rem;
  margin: 2.75rem 0 1rem;
  padding-bottom: 0.4rem;
  border-bottom: 1px solid var(--border);
  color: var(--accent);
}}
h3 {{
  font-size: 1.15rem;
  margin: 2rem 0 0.75rem;
}}
h4 {{
  font-size: 1rem;
  margin: 1.5rem 0 0.5rem;
  color: var(--muted);
}}
p {{ color: var(--text); margin: 0 0 1rem; }}
p em, li em {{ color: var(--muted); font-style: italic; }}
a {{ color: var(--accent); text-decoration: none; }}
a:hover {{ text-decoration: underline; }}
ul, ol {{ padding-left: 1.5rem; margin: 0 0 1rem; }}
li {{ margin-bottom: 0.3rem; }}
code {{
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.88em;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.1em 0.35em;
  color: var(--text);
}}
pre {{
  background: #0c0d0b;
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  padding: 1rem 1.25rem;
  overflow-x: auto;
  margin: 0 0 1.25rem;
  line-height: 1.5;
}}
pre code {{
  background: transparent;
  border: none;
  padding: 0;
  font-size: 0.82rem;
  color: var(--text);
}}
blockquote {{
  border-left: 3px solid var(--accent);
  background: var(--surface);
  margin: 1.25rem 0;
  padding: 0.875rem 1.25rem;
  color: var(--muted);
  font-style: italic;
  border-radius: 0 6px 6px 0;
}}
blockquote strong {{ color: var(--accent); font-style: normal; }}
blockquote p:last-child {{ margin-bottom: 0; }}
table {{
  width: 100%;
  border-collapse: collapse;
  margin: 0 0 1.5rem;
  font-size: 0.88rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  overflow: hidden;
}}
thead th {{
  background: var(--surface);
  color: var(--dim);
  text-align: left;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 0.7rem;
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid var(--border);
}}
tbody td {{
  padding: 0.6rem 0.8rem;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  vertical-align: top;
}}
tbody tr:last-child td {{ border-bottom: none; }}
tbody tr:hover td {{ background: var(--surface); }}
hr {{
  border: none;
  border-top: 1px solid var(--border);
  margin: 2.25rem 0;
}}
.mermaid {{
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1.25rem;
  margin: 1.25rem 0;
  text-align: center;
}}
.task-list-item {{ list-style: none; margin-left: -1.25rem; }}
.task-list-item input[type="checkbox"] {{
  margin-right: 0.5rem;
  accent-color: var(--accent);
}}
ol > li > a, ul > li > a {{ color: var(--accent); }}
</style>
</head>
<body>
<div class="preview-banner">
  <strong>preview</strong> · rendered from <code>{src_name}</code> · generated — do not edit
</div>
<main>
{body}
</main>
<script>
  mermaid.initialize({{
    startOnLoad: true,
    theme: 'base',
    themeVariables: {{
      darkMode: true,
      background: '#1a1b18',
      primaryColor: '#1a1b18',
      primaryTextColor: '#f0ede6',
      primaryBorderColor: '#f0b429',
      lineColor: '#f0b429',
      secondaryColor: '#2e3028',
      tertiaryColor: '#111210',
      mainBkg: '#1a1b18',
      nodeBorder: '#f0b429',
      clusterBkg: '#111210',
      clusterBorder: '#2e3028',
      edgeLabelBackground: '#1a1b18',
      fontFamily: 'Inter, system-ui, sans-serif',
      fontSize: '14px'
    }}
  }});
</script>
</body>
</html>
"""


def mermaid_fence(source, language, css_class, options, md, **kwargs):
    """pymdownx.superfences custom formatter — wrap mermaid blocks in a div."""
    return f'<div class="mermaid">{source}</div>'


def render(src: Path, dst: Path) -> tuple[int, int]:
    """Render a markdown file to a themed HTML preview. Returns (src_bytes, dst_bytes)."""
    md = markdown.Markdown(
        extensions=[
            "extra",
            "codehilite",
            "toc",
            "sane_lists",
            "pymdownx.tasklist",
            "pymdownx.superfences",
        ],
        extension_configs={
            "pymdownx.superfences": {
                "custom_fences": [
                    {"name": "mermaid", "class": "mermaid", "format": mermaid_fence}
                ]
            },
            "pymdownx.tasklist": {"custom_checkbox": True},
        },
    )

    src_text = src.read_text(encoding="utf-8")
    body = md.convert(src_text)

    title = src.stem
    for line in src_text.splitlines():
        if line.startswith("# "):
            title = line.lstrip("# ").strip()
            break

    html = SHELL.format(title=title, src_name=src.name, body=body)
    dst.write_text(html, encoding="utf-8")
    return len(src_text), len(html)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Render a markdown file to a themed preview HTML.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "input",
        nargs="?",
        type=Path,
        default=DEFAULT_INPUT,
        help=f"input markdown file (default: {DEFAULT_INPUT})",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="output HTML path (default: <input>.preview.html)",
    )
    args = parser.parse_args()

    src: Path = args.input.resolve()
    if not src.exists():
        print(f"error: input not found: {src}", file=sys.stderr)
        return 2
    if src.suffix != ".md":
        print(f"error: expected a .md file, got: {src.suffix}", file=sys.stderr)
        return 2

    dst: Path = args.output.resolve() if args.output else src.with_suffix(".md.preview.html")
    dst.parent.mkdir(parents=True, exist_ok=True)

    src_bytes, dst_bytes = render(src, dst)

    try:
        src_display = src.relative_to(Path.home())
        src_display = Path("~") / src_display
    except ValueError:
        src_display = src
    try:
        dst_display = dst.relative_to(Path.home())
        dst_display = Path("~") / dst_display
    except ValueError:
        dst_display = dst

    print(f"✓ rendered  {src_display}", file=sys.stderr)
    print(f"  →         {dst_display}", file=sys.stderr)
    print(f"            {src_bytes:,} bytes md → {dst_bytes:,} bytes html", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
