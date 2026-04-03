import json
from pathlib import Path
from .base import BaseTemplate


def hsl_to_hex(h, s, l):
    h = h % 360
    c = (1 - abs(2 * l - 1)) * s
    x = c * (1 - abs((h / 60) % 2 - 1))
    m = l - c / 2
    if h < 60:    r, g, b = c, x, 0
    elif h < 120: r, g, b = x, c, 0
    elif h < 180: r, g, b = 0, c, x
    elif h < 240: r, g, b = 0, x, c
    elif h < 300: r, g, b = x, 0, c
    else:         r, g, b = c, 0, x
    r, g, b = int((r + m) * 255), int((g + m) * 255), int((b + m) * 255)
    return f"#{r:02x}{g:02x}{b:02x}"


class ColorPaletteTemplate(BaseTemplate):
    name = "color-palette"
    artifact_type = "html"

    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        return {
            "pole_name": pole["name"],
            "primary_hue": float(pole.get("primary_hue", 220)),
            "saturation": float(pole.get("saturation", 0.6)),
            "lightness": float(pole.get("lightness", 0.5)),
            "accent_hue": float(pole.get("accent_hue", pole.get("primary_hue", 220) + 30)),
        }

    def _clamp(self, v, lo, hi):
        return max(lo, min(hi, v))

    def mutate(self, parent_params: dict, mutation: str, vocabulary: dict, parent_id: str) -> dict:
        p = dict(parent_params)
        vocab = vocabulary.get("mutation_vocab", {})

        if mutation == "amplify":
            delta_s = vocab.get("amplify", {}).get("saturation", 0.15)
            delta_c = vocab.get("amplify", {}).get("contrast", 0.1)
            p["saturation"] = self._clamp(p["saturation"] + delta_s, 0, 1)
            p["lightness"] = self._clamp(p["lightness"] - delta_c, 0.1, 0.9)
            p["pole_name"] = p["pole_name"] + "-amplified"

        elif mutation == "blend":
            weight = vocab.get("blend", {}).get("weight", 0.5)
            p["primary_hue"] = (p["primary_hue"] + 30 * (1 if "cool" in p["pole_name"] else -1)) % 360
            p["saturation"] = self._clamp(p["saturation"] * (1 - weight) + 0.5 * weight, 0, 1)
            p["pole_name"] = p["pole_name"] + "-blended"

        elif mutation == "refine":
            delta_s = vocab.get("refine", {}).get("saturation", -0.08)
            p["saturation"] = self._clamp(p["saturation"] + delta_s, 0, 1)
            p["lightness"] = self._clamp(p["lightness"] + (0.5 - p["lightness"]) * 0.1, 0.1, 0.9)
            p["pole_name"] = p["pole_name"] + "-refined"

        return p

    def build_prompt(self, params: dict, anchor: str) -> str:
        return json.dumps(params)

    def artifact_path(self, node_id: str, round_num: int) -> str:
        return f"round_{round_num}/{node_id}.html"

    def render_sync(self, node: dict, session_dir: Path, vocabulary: dict) -> Path:
        params = node["params"]
        h = params["primary_hue"]
        s = params["saturation"]
        l = params["lightness"]
        ah = params["accent_hue"]
        anchor = node.get("anchor", "")

        colors = [
            ("950", hsl_to_hex(h, s, l * 0.15)),
            ("700", hsl_to_hex(h, s, l * 0.45)),
            ("500", hsl_to_hex(h, s, l)),
            ("300", hsl_to_hex(h, s * 0.7, l * 1.4)),
            ("100", hsl_to_hex(h, s * 0.3, l * 1.7)),
        ]
        accent = hsl_to_hex(ah, min(s * 1.1, 1), l)

        swatches_html = "\n".join(
            f'<div class="swatch" style="background:{color}"><span>{name}</span><span>{color}</span></div>'
            for name, color in colors
        )

        html = f"""<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body {{ font-family: system-ui; background: #111; color: #eee; padding: 2rem; }}
  h2 {{ margin: 0 0 1rem; font-size: 1rem; opacity: 0.6; }}
  .palette {{ display: flex; gap: 0.5rem; margin-bottom: 1rem; }}
  .swatch {{ flex: 1; height: 80px; border-radius: 8px; display: flex; flex-direction: column; justify-content: space-between; padding: 0.5rem; font-size: 0.7rem; }}
  .accent {{ width: 2rem; height: 2rem; border-radius: 50%; display: inline-block; vertical-align: middle; margin-left: 0.5rem; }}
</style>
</head>
<body>
<h2>{params['pole_name']} · {anchor}</h2>
<div class="palette">{swatches_html}</div>
<p>Accent <span class="accent" style="background:{accent}"></span> {accent}</p>
</body>
</html>"""

        out_path = session_dir / node["artifact"]
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html)
        return out_path
