#!/usr/bin/env python3
"""Generate manifest.json files for image galleries — API-style listing for static hosting.

Writes two kinds of manifest.json under FORGE_DIR so galleries can discover
content without the serve.py /api/list/ endpoint:

1. **Leaf manifests** — one per directory containing image files.
   Entries: [{ name, size, mtime, is_dir: False }, …] for every image.
   Consumed by `discoverFiles(dir, ext)` in gallery-base.js.

2. **Parent manifests** — one per directory whose subtree contains any leaf
   manifest. Entries: [{ name, size, mtime, is_dir: True }, …] for every
   immediate subdirectory that recursively contains images.
   Consumed by `discoverDirs(dir)` in gallery-base.js for two-level galleries
   (LoRA variants, batches, runs, etc.).

Extensions scanned: .png, .jpg, .jpeg, .webp, .gif, .avif.
"""
import json
import os
from pathlib import Path

FORGE_DIR = Path(os.environ.get('FORGE_DIR', Path.home() / '.roxabi' / 'forge'))
SKIP = {'_dist', '__pycache__', '.git', '.stversions'}
EXTS = ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif')

# Track which directories contain images (directly) so parent manifests know
# which immediate subdirs are worth listing.
dirs_with_images: set[Path] = set()

# ── Pass 1: leaf manifests ───────────────────────────────────────────────
# followlinks=True so symlinked run dirs (e.g. ai-toolkit training output
# symlinked into concepts/avatar-lyra-v23/) are scanned. Combined with
# `rsync -aL` in build.sh this also means the deployed _dist/ ships real
# files rather than broken symlinks.
for dirpath, dirnames, filenames in os.walk(FORGE_DIR, followlinks=True):
    dirnames[:] = [d for d in dirnames if d not in SKIP]
    images = sorted(f for f in filenames if f.lower().endswith(EXTS))
    if not images:
        continue
    d = Path(dirpath)
    dirs_with_images.add(d)
    entries = [
        {
            'name': f,
            'size': (d / f).stat().st_size,
            'mtime': int((d / f).stat().st_mtime),
            'is_dir': False,
        }
        for f in images
    ]
    (d / 'manifest.json').write_text(json.dumps(entries, indent=2) + '\n')
    print(f'  [leaf]   {d.relative_to(FORGE_DIR)}/manifest.json: {len(entries)} images')

# ── Pass 2: parent manifests ─────────────────────────────────────────────
# For each dir that has images, propagate its existence up to every ancestor
# STRICTLY BELOW FORGE_DIR. Each ancestor gets a manifest listing the immediate
# children (subdirs) that are themselves in `dirs_with_images` or are ancestors
# of a dir that is.
#
# FORGE_DIR itself is excluded: the root manifest.json is the diagrams registry
# (produced by gen-manifest.py) with a different schema — must not overwrite.
parents_with_image_subtree: dict[Path, set[str]] = {}
for img_dir in dirs_with_images:
    cur = img_dir
    while True:
        parent = cur.parent
        if parent == cur or parent == FORGE_DIR or parent == FORGE_DIR.parent:
            break
        parents_with_image_subtree.setdefault(parent, set()).add(cur.name)
        cur = parent

for parent, child_names in parents_with_image_subtree.items():
    # Don't overwrite a leaf manifest with a parent manifest — if this dir also
    # directly contains images, merge: list both the image files AND the
    # subdirs that have image subtrees.
    existing: list[dict] = []
    if parent in dirs_with_images:
        existing = json.loads((parent / 'manifest.json').read_text())
    dir_entries = []
    for name in sorted(child_names):
        sub = parent / name
        try:
            st = sub.stat()
            dir_entries.append(
                {
                    'name': name,
                    'size': 0,
                    'mtime': int(st.st_mtime),
                    'is_dir': True,
                }
            )
        except OSError:
            continue
    merged = existing + dir_entries
    (parent / 'manifest.json').write_text(json.dumps(merged, indent=2) + '\n')
    label = 'merged' if existing else 'parent'
    print(
        f'  [{label}] {parent.relative_to(FORGE_DIR)}/manifest.json: '
        f'{len(existing)} images + {len(dir_entries)} subdirs'
    )
