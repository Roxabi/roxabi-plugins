"""IDNA shared constants and configuration."""

from __future__ import annotations

import logging
import os
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("idna")

# Root directory: ~/.roxabi/idna/ (where sessions live and templates/ resides)
# idna_server.py lives at the root of that directory; the package is one level below.
IDNA_DIR = Path(os.environ["IDNA_DIR"]) if "IDNA_DIR" in os.environ else Path.home() / ".roxabi" / "idna"

IMAGECLI_PROJECT = Path.home() / "projects" / "imageCLI"

# ── Resolution ────────────────────────────────────────────────────────────────
TREE_WIDTH   = 384   # low-res for all tree nodes (fast selection)
TREE_HEIGHT  = 512
FINAL_WIDTH  = 768   # hi-res re-gen of winner at finalize
FINAL_HEIGHT = 1024

# ── imageCLI daemon client ───────────────────────────────────────────────────
DAEMON_SOCK = Path.home() / ".local" / "share" / "imagecli" / "daemon.sock"

# ── Node helpers ─────────────────────────────────────────────────────────────
_CHILD_SUFFIXES = ["va", "vb", "vc", "vd", "ve", "vf", "vg", "vh", "vi"]
_MUTATION_CYCLE = ["amplify", "blend", "refine"]
_SUFFIX_INDEX   = {s: i for i, s in enumerate(_CHILD_SUFFIXES)}

# ── Ratio table ───────────────────────────────────────────────────────────────
_RATIOS: dict[str, tuple[int, int]] = {
    "1:1": (1, 1), "3:4": (3, 4), "9:16": (9, 16),
    "4:3": (4, 3), "16:9": (16, 9),
}

# ── MIME types ────────────────────────────────────────────────────────────────
MIME: dict[str, str] = {
    ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
    ".html": "text/html", ".json": "application/json",
}
