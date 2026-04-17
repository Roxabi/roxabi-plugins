from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger("idna")

# Python fallback classes (used when no .toml file exists for the type)
from .avatar import AvatarTemplate
from .logo import LogoTemplate
from .voice import VoiceTemplate
from .color_palette import ColorPaletteTemplate
from .ui_component import UIComponentTemplate
from .icon_set import IconSetTemplate
from .motion_curve import MotionCurveTemplate

_PY_TEMPLATES: dict[str, type] = {
    "avatar": AvatarTemplate,
    "logo": LogoTemplate,
    "voice": VoiceTemplate,
    "color-palette": ColorPaletteTemplate,
    "ui-component": UIComponentTemplate,
    "icon-set": IconSetTemplate,
    "motion-curve": MotionCurveTemplate,
}

# TOML types directory: IDNA_DIR/types/*.toml
# Resolved lazily so IDNA_DIR is available at call time.
def _types_dir() -> Path:
    idna_dir = Path(os.environ.get("IDNA_DIR", Path.home() / ".roxabi" / "idna"))
    return idna_dir / "types"


def get_template(name: str):
    """
    Return a template instance for the given type name.

    Resolution order:
      1. IDNA_DIR/types/{name}.toml  — TOML config (hot-reloadable, auto-discovered)
      2. Python class in _PY_TEMPLATES — existing Python templates (fallback)

    Dropping a new .toml file in types/ creates a new type with no code changes.
    """
    from .base import TomlAxisTemplate

    toml_path = _types_dir() / f"{name}.toml"
    if toml_path.exists():
        try:
            return TomlAxisTemplate.from_file(toml_path)
        except Exception as exc:
            log.warning("Failed to load TOML template %s: %s — falling back to Python", name, exc)

    cls = _PY_TEMPLATES.get(name)
    if cls:
        return cls()

    # Auto-discover any other .toml files
    td = _types_dir()
    if td.exists():
        for p in td.glob("*.toml"):
            if p.stem.startswith("_"):
                continue
            try:
                t = TomlAxisTemplate.from_file(p)
                if t.name == name:
                    return t
            except Exception:
                pass

    available = list(_PY_TEMPLATES) + [
        p.stem for p in _types_dir().glob("*.toml") if not p.stem.startswith("_")
    ] if _types_dir().exists() else list(_PY_TEMPLATES)
    raise ValueError(f"Unknown template: {name!r}. Available: {sorted(set(available))}")


def list_templates() -> list[str]:
    """Return all available template names (TOML + Python)."""
    names: set[str] = set(_PY_TEMPLATES)
    td = _types_dir()
    if td.exists():
        for p in td.glob("*.toml"):
            if not p.stem.startswith("_"):
                names.add(p.stem)
    return sorted(names)
