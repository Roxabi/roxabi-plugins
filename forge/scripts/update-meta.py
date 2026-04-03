#!/usr/bin/env python3
"""update-meta.py — one-shot script to audit and correct all diagram meta tags.

Strategy:
  - Use <title> from the HTML as the authoritative title for most files.
  - OVERRIDES dict wins when the html <title> is too generic or missing version info.
  - New files (no existing meta block) get full metadata from NEW_FILES dict.
  - After running, call gen-manifest.py to rebuild manifest.json.
"""
import os, re, html as html_lib
from pathlib import Path

DIR = Path(os.environ.get('FORGE_DIR', os.environ.get('DIAGRAMS_DIR', Path.home() / '.roxabi' / 'forge')))

START = '<!-- diagram-meta:start -->'
END   = '<!-- diagram-meta:end -->'
BLOCK_RE   = re.compile(r'\s*' + re.escape(START) + r'.*?' + re.escape(END) + r'\n?', re.DOTALL)
HTML_TITLE = re.compile(r'<title>(.*?)</title>', re.IGNORECASE | re.DOTALL)
META_RE    = re.compile(r'<meta\s+name="diagram:([\w-]+)"\s+content="([^"]*)"', re.IGNORECASE)


# ── Title overrides (when <title> is too generic or strips useful version info) ──
TITLE_OVERRIDES = {
    # Strip "// Lyra" suffix that appears in some issue plan titles
    '44-event-driven-monitoring-plan.html': 'Issue #44 — Event-Driven Agent Monitoring',
    # Voice flow: html title is the French subtitle, meta title is cleaner
    'lyra-voice-flow.html': 'Lyra — Voice Flow (flux complet)',
    # Add version suffix to generic html titles
    'lyra-user-guide-v6.html': 'Lyra — Documentation v6',
    'lyra-user-guide.html':    'Lyra — Complete User Guide v1',
    # VALORA files: html <title> doesn't mention v1/v2
    'valora-ai-v2.html': 'VALORA v2',
    'valora-ai.html':    'VALORA.AI v1',
}

# ── Fully new files that have no meta block yet ──
NEW_FILES = {
    'lyra-customer-personas.html': {
        'd': '2026-03-18', 'cat': 'lyra', 'cl': 'Lyra Docs', 'c': 'blue', 'b': [],
    },
    'lyra-messaging-framework.html': {
        'd': '2026-03-18', 'cat': 'lyra', 'cl': 'Lyra Docs', 'c': 'blue', 'b': [],
    },
    'lyra-positioning-exploration.html': {
        'd': '2026-03-18', 'cat': 'lyra', 'cl': 'Lyra Docs', 'c': 'blue', 'b': [],
    },
}


def read_existing_meta(text):
    return dict(META_RE.findall(text))


def html_title(text):
    m = HTML_TITLE.search(text)
    if not m:
        return ''
    return html_lib.unescape(m.group(1).strip())


def build_block(title, date, cat, cl, color, badges):
    lines = [
        START,
        f'<meta name="diagram:title"     content="{title}">',
        f'<meta name="diagram:date"      content="{date}">',
        f'<meta name="diagram:category"  content="{cat}">',
        f'<meta name="diagram:cat-label" content="{cl}">',
        f'<meta name="diagram:color"     content="{color}">',
    ]
    if badges:
        lines.append(f'<meta name="diagram:badges"    content="{",".join(badges)}">')
    lines.append(END)
    return '\n'.join(lines) + '\n'


def inject(filepath, block):
    text = filepath.read_text(encoding='utf-8')
    text = BLOCK_RE.sub('', text)
    text = text.replace('</head>', block + '</head>', 1)
    filepath.write_text(text, encoding='utf-8')


ok = skip = 0

for fp in sorted(DIR.glob('*.html')):
    if fp.name == 'index.html':
        continue

    text = fp.read_text(encoding='utf-8')
    existing = read_existing_meta(text)
    htitle   = html_title(text)

    if fp.name in NEW_FILES:
        # Brand new file — bootstrap from NEW_FILES dict
        info = NEW_FILES[fp.name]
        title  = TITLE_OVERRIDES.get(fp.name, htitle) or fp.stem
        badges = info.get('b', [])
        block  = build_block(title, info['d'], info['cat'], info['cl'], info['c'], badges)
        inject(fp, block)
        print(f'NEW  {fp.name}  →  {title!r}')
        ok += 1
        continue

    if not existing:
        print(f'SKIP {fp.name}  (no existing meta and not in NEW_FILES)')
        skip += 1
        continue

    # Determine the best title
    title = TITLE_OVERRIDES.get(fp.name) or htitle or existing.get('title', fp.stem)

    # Keep everything else from the existing meta
    date   = existing.get('date', '')
    cat    = existing.get('category', '')
    cl     = existing.get('cat-label', '')
    color  = existing.get('color', 'blue')
    badges = [b.strip() for b in existing.get('badges', '').split(',') if b.strip()]

    block = build_block(title, date, cat, cl, color, badges)
    inject(fp, block)

    old_title = existing.get('title', '')
    if old_title != title:
        print(f'UPD  {fp.name}')
        print(f'       {old_title!r}')
        print(f'    →  {title!r}')
    else:
        print(f'OK   {fp.name}')
    ok += 1

print(f'\nDone: {ok} updated, {skip} skipped.')
print('Next: python3 gen-manifest.py')
