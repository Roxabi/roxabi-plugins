from .base import AxisTemplate

DEFAULT_ANCHOR = "personnal avatar"

DEFAULT_AXES = [
    {"name": "medium",      "low": "photo, photorealistic, camera",               "high": "illustration, painterly, stylized"},
    {"name": "proportion",  "low": "chibi, super-deformed, SD, big head small body", "high": "realistic proportions, anatomical, normal body ratio"},
    {"name": "aesthetic",   "low": "kawaii, pastel colors, cute, soft, adorable",  "high": "manga, ink lines, screentone, graphic novel, black and white"},
    {"name": "finish",      "low": "matte, flat, minimal rendering",               "high": "glossy, detailed, rich texture"},
    {"name": "energy",      "low": "calm, serene, soft, gentle",                   "high": "dynamic, bold, expressive, intense"},
    {"name": "geometry",    "low": "organic shapes, flowing curves",               "high": "geometric, angular, sharp edges"},
    {"name": "weight",      "low": "light, airy, delicate strokes",                "high": "bold, heavy, impactful, saturated"},
    {"name": "saturation",  "low": "desaturated, muted, neutral, grey",            "high": "vibrant, saturated, vivid color"},
    {"name": "hue_shift",   "low": "green, teal, emerald, jade tones",             "high": "purple, violet, magenta tones"},
    {"name": "warmth",      "low": "cool tones, blue-grey palette",                "high": "warm tones, amber-golden palette"},
    {"name": "hue",         "low": "cool, blue-purple dominant",                   "high": "warm, red-orange dominant"},
    {"name": "background",  "low": "light background, white, bright",              "high": "dark background, black, deep"},
    {"name": "complexity",  "low": "minimal, clean, simple composition",           "high": "complex, layered, detailed, busy"},
    {"name": "lighting",    "low": "flat, even, ambient light, soft fill",          "high": "dramatic, rim light, chiaroscuro, strong shadows"},
    {"name": "line_weight", "low": "thin, delicate, hairline linework",              "high": "thick, bold, heavy outlines, strong contours"},
    {"name": "perspective", "low": "close-up portrait, face only, bust",             "high": "full body, wide shot, head-to-toe"},
    {"name": "expression",  "low": "neutral, calm, serene, resting face",            "high": "intense, emotional, dramatic expression"},
    {"name": "age",         "low": "young, youthful, fresh-faced, childlike",        "high": "mature, weathered, aged, adult"},
    {"name": "texture",     "low": "smooth, clean, digital, polished",               "high": "rough, painterly, textured brush strokes"},
]

DEFAULT_AXIS_PRIORITY = [
    "medium", "proportion", "aesthetic",
    "finish", "energy", "saturation",
    "hue_shift", "warmth", "hue",
    "geometry", "weight", "background", "complexity",
    "lighting", "line_weight", "perspective", "expression", "age", "texture",
]


class AvatarTemplate(AxisTemplate):
    name = "avatar"
    artifact_type = "image"

    TREE_WIDTH = 256
    TREE_HEIGHT = 320
    FINAL_WIDTH = 768
    FINAL_HEIGHT = 1024

    def _prompt_template(self, anchor: str, tags: str) -> str:
        return f"{anchor}, {tags}, portrait photography, professional"
