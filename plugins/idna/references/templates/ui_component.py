import json
from pathlib import Path
from .base import BaseTemplate


class UIComponentTemplate(BaseTemplate):
    name = "ui-component"
    artifact_type = "html"

    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        return {
            "pole_name": pole["name"],
            "border_radius": float(pole.get("border_radius", 6)),
            "shadow_depth": float(pole.get("shadow_depth", 0.5)),
            "spacing": float(pole.get("spacing", 1.0)),
            "font_weight": int(pole.get("font_weight", 500)),
        }

    def _clamp(self, v, lo, hi):
        return max(lo, min(hi, v))

    def mutate(self, parent_params: dict, mutation: str, vocabulary: dict, parent_id: str) -> dict:
        p = dict(parent_params)
        if mutation == "amplify":
            p["border_radius"] = self._clamp(p["border_radius"] * 1.5, 0, 32)
            p["shadow_depth"] = self._clamp(p["shadow_depth"] * 1.4, 0, 1)
            p["spacing"] = self._clamp(p["spacing"] * 1.2, 0.5, 3)
            p["pole_name"] = p["pole_name"] + "-amplified"
        elif mutation == "blend":
            p["border_radius"] = self._clamp(p["border_radius"] * 0.8 + 6 * 0.2, 0, 32)
            p["shadow_depth"] = self._clamp(p["shadow_depth"] * 0.8 + 0.5 * 0.2, 0, 1)
            p["pole_name"] = p["pole_name"] + "-blended"
        elif mutation == "refine":
            p["border_radius"] = round(p["border_radius"] / 2) * 2
            p["shadow_depth"] = self._clamp(p["shadow_depth"] * 0.9, 0, 1)
            p["pole_name"] = p["pole_name"] + "-refined"
        return p

    def build_prompt(self, params: dict, anchor: str) -> str:
        return json.dumps(params)

    def artifact_path(self, node_id: str, round_num: int) -> str:
        return f"round_{round_num}/{node_id}.html"

    def render_sync(self, node: dict, session_dir: Path, vocabulary: dict) -> Path:
        p = node["params"]
        r = p["border_radius"]
        sd = p["shadow_depth"]
        sp = p["spacing"]
        fw = p["font_weight"]
        shadow = f"0 {int(sd*16)}px {int(sd*32)}px rgba(0,0,0,{sd*0.4:.2f})"
        anchor = node.get("anchor", "Component")

        html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body {{ font-family: system-ui; background: #0f0f0f; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }}
  .card {{ background: #1a1a1a; border-radius: {r}px; padding: {sp*1.5}rem {sp*2}rem; box-shadow: {shadow}; max-width: 320px; width: 100%; }}
  h3 {{ margin: 0 0 {sp*0.5}rem; font-weight: {fw}; color: #fff; font-size: 1.1rem; }}
  p {{ margin: 0 0 {sp}rem; color: #aaa; font-size: 0.9rem; line-height: 1.5; }}
  button {{ border-radius: {r*0.7}px; padding: {sp*0.5}rem {sp*1.2}rem; background: #fff; color: #000; border: none; font-weight: {fw}; cursor: pointer; font-size: 0.9rem; }}
</style>
</head>
<body>
<div class="card">
  <h3>{anchor}</h3>
  <p>A sample card component with the selected visual parameters applied.</p>
  <button>Action</button>
</div>
</body>
</html>"""
        out_path = session_dir / node["artifact"]
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html)
        return out_path
