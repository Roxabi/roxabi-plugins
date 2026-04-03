import json
from pathlib import Path
from .base import BaseTemplate


class IconSetTemplate(BaseTemplate):
    name = "icon-set"
    artifact_type = "html"

    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        return {
            "pole_name": pole["name"],
            "stroke_width": float(pole.get("stroke_width", 1.5)),
            "corner_radius": float(pole.get("corner_radius", 2)),
            "fill": pole.get("fill", "none"),  # "none" | "solid" | "duotone"
            "size": int(pole.get("size", 24)),
        }

    def _clamp(self, v, lo, hi):
        return max(lo, min(hi, v))

    def mutate(self, parent_params: dict, mutation: str, vocabulary: dict, parent_id: str) -> dict:
        p = dict(parent_params)
        fills = ["none", "solid", "duotone"]
        fi = fills.index(p.get("fill", "none"))
        if mutation == "amplify":
            p["stroke_width"] = self._clamp(p["stroke_width"] * 1.5, 0.5, 4)
            p["corner_radius"] = self._clamp(p["corner_radius"] * 1.5, 0, 8)
            p["pole_name"] = p["pole_name"] + "-amplified"
        elif mutation == "blend":
            p["stroke_width"] = self._clamp(p["stroke_width"] * 0.8 + 1.5 * 0.2, 0.5, 4)
            p["fill"] = fills[min(fi + 1, len(fills) - 1)]
            p["pole_name"] = p["pole_name"] + "-blended"
        elif mutation == "refine":
            p["stroke_width"] = round(p["stroke_width"] * 2) / 2
            p["corner_radius"] = round(p["corner_radius"])
            p["pole_name"] = p["pole_name"] + "-refined"
        return p

    def build_prompt(self, params: dict, anchor: str) -> str:
        return json.dumps(params)

    def artifact_path(self, node_id: str, round_num: int) -> str:
        return f"round_{round_num}/{node_id}.html"

    def render_sync(self, node: dict, session_dir: Path, vocabulary: dict) -> Path:
        p = node["params"]
        sw = p["stroke_width"]
        cr = p["corner_radius"]
        fill = p["fill"]
        size = p["size"]
        anchor = node.get("anchor", "Icons")

        def icon(path_d, label):
            opacity = "0.2" if fill == "duotone" else "1"
            fill_el = f'<path d="{path_d}" fill="currentColor" opacity="{opacity}"/>' if fill != "none" else ""
            return f'''<div class="icon-wrap">
              <svg viewBox="0 0 24 24" width="{size}" height="{size}" fill="none" stroke="currentColor" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round">
                {fill_el}
                <path d="{path_d}" fill="none"/>
              </svg>
              <span>{label}</span>
            </div>'''

        icons_html = "\n".join([
            icon("M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z", "Home"),
            icon("M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z", "User"),
            icon("M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z", "Chat"),
            icon("M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z", "Edit"),
            icon("M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0", "Bell"),
            icon("M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", "Shield"),
        ])

        html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body {{ font-family: system-ui; background: #111; color: #eee; padding: 2rem; }}
  h2 {{ margin: 0 0 1rem; font-size: 1rem; opacity: 0.6; }}
  .grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; max-width: 300px; }}
  .icon-wrap {{ display: flex; flex-direction: column; align-items: center; gap: 0.4rem; padding: 1rem; background: #1a1a1a; border-radius: 8px; }}
  .icon-wrap span {{ font-size: 0.65rem; opacity: 0.6; }}
</style>
</head>
<body>
<h2>{p['pole_name']} · sw:{sw} cr:{cr} fill:{fill}</h2>
<div class="grid">{icons_html}</div>
</body>
</html>"""
        out_path = session_dir / node["artifact"]
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html)
        return out_path
