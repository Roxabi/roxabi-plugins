import json
from pathlib import Path
from .base import BaseTemplate


class MotionCurveTemplate(BaseTemplate):
    name = "motion-curve"
    artifact_type = "html"

    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        return {
            "pole_name": pole["name"],
            "x1": float(pole.get("x1", 0.25)),
            "y1": float(pole.get("y1", 0.1)),
            "x2": float(pole.get("x2", 0.25)),
            "y2": float(pole.get("y2", 1.0)),
            "duration": float(pole.get("duration", 0.4)),
            "stagger": float(pole.get("stagger", 0.05)),
        }

    def _clamp(self, v, lo=0, hi=1):
        return max(lo, min(hi, v))

    def mutate(self, parent_params: dict, mutation: str, vocabulary: dict, parent_id: str) -> dict:
        p = dict(parent_params)
        if mutation == "amplify":
            p["x1"] = self._clamp(p["x1"] * 0.5)
            p["y1"] = self._clamp(p["y1"] * 1.5)
            p["y2"] = self._clamp(p["y2"] * 1.1)
            p["duration"] = max(0.1, p["duration"] * 0.7)
            p["pole_name"] = p["pole_name"] + "-amplified"
        elif mutation == "blend":
            p["x1"] = (p["x1"] + 0.42) / 2
            p["y1"] = p["y1"] / 2
            p["x2"] = (p["x2"] + 0.58) / 2
            p["y2"] = (p["y2"] + 1.0) / 2
            p["pole_name"] = p["pole_name"] + "-blended"
        elif mutation == "refine":
            p["x1"] = round(p["x1"] * 4) / 4
            p["y1"] = round(p["y1"] * 4) / 4
            p["x2"] = round(p["x2"] * 4) / 4
            p["y2"] = round(p["y2"] * 4) / 4
            p["duration"] = round(p["duration"] / 0.05) * 0.05
            p["pole_name"] = p["pole_name"] + "-refined"
        return p

    def build_prompt(self, params: dict, anchor: str) -> str:
        return json.dumps(params)

    def artifact_path(self, node_id: str, round_num: int) -> str:
        return f"round_{round_num}/{node_id}.html"

    def render_sync(self, node: dict, session_dir: Path, vocabulary: dict) -> Path:
        p = node["params"]
        x1, y1, x2, y2 = p["x1"], p["y1"], p["x2"], p["y2"]
        dur = p["duration"]
        stagger = p["stagger"]
        easing = f"cubic-bezier({x1},{y1},{x2},{y2})"
        anchor = node.get("anchor", "Motion")

        html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body {{ font-family: system-ui; background: #111; color: #eee; padding: 2rem; overflow: hidden; }}
  h2 {{ margin: 0 0 0.5rem; font-size: 0.9rem; opacity: 0.6; }}
  code {{ font-size: 0.75rem; opacity: 0.5; display: block; margin-bottom: 1.5rem; }}
  .track {{ background: #1a1a1a; border-radius: 4px; height: 48px; margin-bottom: 0.75rem; position: relative; overflow: hidden; }}
  .ball {{ position: absolute; left: 4px; top: 50%; transform: translateY(-50%); width: 24px; height: 24px; border-radius: 50%; background: #fff; animation: slide {dur}s {easing} infinite alternate; }}
  .ball:nth-child(2) {{ animation-delay: {stagger}s; background: #aaa; top: calc(50% - 8px); width: 16px; height: 16px; }}
  .ball:nth-child(3) {{ animation-delay: {stagger*2}s; background: #666; top: calc(50% + 4px); width: 10px; height: 10px; }}
  @keyframes slide {{ from {{ left: 4px; }} to {{ left: calc(100% - 28px); }} }}
</style>
</head>
<body>
<h2>{p['pole_name']}</h2>
<code>{easing} · {dur}s · stagger {stagger}s</code>
<div class="track"><div class="ball"></div><div class="ball"></div><div class="ball"></div></div>
<div class="track"><div class="ball"></div><div class="ball"></div><div class="ball"></div></div>
</body>
</html>"""
        out_path = session_dir / node["artifact"]
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html)
        return out_path
