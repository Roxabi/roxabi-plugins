from .base import AxisTemplate

# Typography axes — excluded from prompt (logos are pure marks, no text)
_EXCLUDED_AXES = {"type_weight", "type_style"}

DEFAULT_ANCHOR = "logo, no letters, no text"

DEFAULT_AXES = [
    {"name": "abstraction",  "low": "literal, representational, figurative",   "high": "abstract, symbolic, non-representational"},
    {"name": "geometry",     "low": "organic shapes, flowing curves, natural",  "high": "geometric, angular, grid-based, sharp"},
    {"name": "complexity",   "low": "minimal, single shape, ultra-simple",      "high": "complex, layered, detailed mark"},
    {"name": "weight",       "low": "thin lines, light, delicate",              "high": "bold, filled, heavy, solid"},
    {"name": "energy",       "low": "static, stable, grounded",                 "high": "dynamic, motion, tension, forward"},
    {"name": "style",        "low": "flat, 2D, clean vector",                   "high": "dimensional, depth, 3D-feel"},
    {"name": "hue",          "low": "cool, blue-cyan dominant",                 "high": "warm, red-orange dominant"},
    {"name": "saturation",   "low": "monochrome, black and white",              "high": "vibrant, full color, multicolor"},
    {"name": "symmetry",     "low": "asymmetric, dynamic, off-balance",         "high": "symmetric, balanced, centred"},
    {"name": "openness",     "low": "enclosed, contained, tight",               "high": "open, airy, breathing space"},
]

DEFAULT_AXIS_PRIORITY = [
    "abstraction", "geometry", "complexity", "weight", "energy",
    "style", "hue", "saturation", "symmetry", "openness",
]


class LogoTemplate(AxisTemplate):
    name = "logo"
    artifact_type = "image"

    TREE_WIDTH = 256
    TREE_HEIGHT = 256
    FINAL_WIDTH = 1024
    FINAL_HEIGHT = 1024

    def _compute_tags(self, params: dict, axes: list[dict]) -> str:
        """Skip typography axes — logo is a pure symbol mark."""
        filtered = [a for a in axes if a["name"] not in _EXCLUDED_AXES]
        return super()._compute_tags(params, filtered)

    def _prompt_template(self, anchor: str, tags: str) -> str:
        return (
            f"logo design for {anchor}, {tags}, "
            f"pure symbol mark, no text, no letters, no words, no typography, "
            f"vector art, professional branding"
        )
