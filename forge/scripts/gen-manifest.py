#!/usr/bin/env python3
"""gen-manifest.py — scan diagram HTML files, read diagram:* meta tags, write manifest.json.

Run after editing meta tags in any diagram file:
    python3 gen-manifest.py

Meta tags read (all in <head>):
    diagram:title     — display title
    diagram:date      — ISO date (YYYY-MM-DD)
    diagram:category  — short key: guide | lyra | ve | ext
    diagram:cat-label — display label: "User Guide", "Lyra Docs", etc.
    diagram:color     — amber | blue | purple | green
    diagram:badges    — comma-separated: latest,split,plan  (any combination)

kb is computed from actual file size (no need to maintain manually).
"""
import glob as globmod
import json, os, re, time
from pathlib import Path

DIR = Path(os.environ.get('FORGE_DIR', os.environ.get('DIAGRAMS_DIR', Path.home() / '.roxabi' / 'forge')))
META_RE = re.compile(r'<meta\s+name="diagram:([\w-]+)"\s+content="([^"]*)"', re.IGNORECASE)
TITLE_RE = re.compile(r'<title>([^<]+)</title>', re.IGNORECASE)

END_MARKER = '<!-- diagram-meta:end -->'

VALID_COLORS = {'amber', 'blue', 'green', 'purple', 'orange', 'cyan', 'red', 'gold'}


def normalize_color(color, filepath=''):
    """Map unknown color values (hex codes, typos) to valid CSS class names.

    The index.html list view renders `<span class="li-dot {color}">` — only
    names in VALID_COLORS match a CSS rule. Anything else (e.g. a hex code
    copy-pasted from a design token) would silently render as an invisible dot.
    """
    if color in VALID_COLORS:
        return color
    if not color:
        return 'blue'
    print(f'  ⚠ unknown color "{color}" in {filepath} — falling back to orange')
    return 'orange'


def parse(filepath, rel=''):
    # Read until our end marker or </head>
    buf = ''
    with open(filepath, encoding='utf-8', errors='ignore') as f:
        for line in f:
            buf += line
            if END_MARKER in line:
                break
            if '</head>' in line.lower():
                break
            if len(buf) > 512 * 1024:  # 512 KB hard cap (safety only)
                break

    metas = dict(META_RE.findall(buf))

    # Fallback: extract <title> when diagram:title meta is missing
    if 'title' not in metas:
        m = TITLE_RE.search(buf)
        if not m:
            return None
        metas['title'] = m.group(1).strip()

    badges = [b.strip() for b in metas.get('badges', '').split(',') if b.strip()]
    kb = max(1, round(filepath.stat().st_size / 1024))

    # Infer category from path when not in meta
    cat = metas.get('category', '')
    cat_label = metas.get('cat-label', '')
    color = metas.get('color', '')
    if not cat:
        if rel.startswith('brand/'):
            cat, cat_label, color = 'brand', 'Lyra Brand', 'amber'
        elif rel.startswith('lyra-visuals/') or filepath.name.startswith('lyra-'):
            cat, cat_label, color = 'lyra', 'Lyra Docs', 'blue'
        elif filepath.name.startswith('ve-'):
            cat, cat_label, color = 've', 'Visual Explainer', 'purple'
        else:
            cat, cat_label, color = 'ext', 'External', 'green'
    color = normalize_color(color, filepath)

    # Infer date from file mtime when not in meta
    date = metas.get('date', '')
    if not date:
        date = time.strftime('%Y-%m-%d', time.localtime(filepath.stat().st_mtime))

    return {
        'f':  filepath.name,
        't':  metas['title'],
        'd':  date,
        'kb': kb,
        'cat': cat,
        'cl': cat_label,
        'c':  color,
        'b':  badges,
    }


entries, skipped = [], []
for match in sorted(globmod.glob(str(DIR / '**/*.html'), recursive=True)):
    fp = Path(match)
    rel = str(fp.relative_to(DIR))
    if fp.name == 'index.html' or '/tabs/' in rel or rel.startswith('tabs/') or rel.startswith('_dist/'):
        continue
    entry = parse(fp, rel)
    if entry:
        entry['f'] = rel
        entries.append(entry)
    else:
        skipped.append(rel)

out = DIR / 'manifest.json'
out.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + '\n')

print(f'manifest.json — {len(entries)} visuals written.')
if skipped:
    print(f'Skipped (no diagram meta): {", ".join(skipped)}')
