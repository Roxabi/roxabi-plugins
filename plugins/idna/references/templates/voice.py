import json
from pathlib import Path
from .base import BaseTemplate


class VoiceTemplate(BaseTemplate):
    name = "voice"
    artifact_type = "audio"

    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        return {
            "pole_name": pole["name"],
            "pace": float(pole.get("pace", 1.0)),
            "warmth": float(pole.get("warmth", 0.5)),
            "energy": float(pole.get("energy", 0.5)),
            "brightness": float(pole.get("brightness", 0.5)),
        }

    def _clamp(self, v, lo=0.1, hi=1.5):
        return max(lo, min(hi, v))

    def mutate(self, parent_params: dict, mutation: str, vocabulary: dict, parent_id: str) -> dict:
        p = dict(parent_params)
        vocab = vocabulary.get("mutation_vocab", {})

        if mutation == "amplify":
            scale = vocab.get("amplify", {}).get("scale", 1.3)
            for k in ["pace", "warmth", "energy", "brightness"]:
                v = p[k]
                p[k] = self._clamp(0.5 + (v - 0.5) * scale)
            p["pole_name"] = p["pole_name"] + "-amplified"

        elif mutation == "blend":
            weight = vocab.get("blend", {}).get("weight", 0.5)
            contrast_name = None
            base_name = p.get("pole_name", "").replace("-blended", "").replace("-amplified", "").replace("-refined", "")
            for pole in vocabulary.get("poles", []):
                if pole["name"] == base_name:
                    contrast_name = pole.get("contrast")
                    break
            contrast_params = None
            for pole in vocabulary.get("poles", []):
                if pole["name"] == contrast_name:
                    contrast_params = pole
                    break
            if contrast_params:
                for k in ["pace", "warmth", "energy", "brightness"]:
                    p[k] = self._clamp(p[k] * (1 - weight) + float(contrast_params.get(k, 0.5)) * weight)
            p["pole_name"] = p["pole_name"] + "-blended"

        elif mutation == "refine":
            nudge = vocab.get("refine", {}).get("nudge", 0.05)
            for k in ["pace", "warmth", "energy", "brightness"]:
                v = p[k]
                p[k] = self._clamp(v + (0.5 - v) * nudge)
            p["pole_name"] = p["pole_name"] + "-refined"

        return p

    def build_prompt(self, params: dict, anchor: str) -> str:
        sample = anchor
        return json.dumps({
            "sample": sample,
            "pace": params["pace"],
            "warmth": params["warmth"],
            "energy": params["energy"],
            "brightness": params["brightness"],
        })

    def artifact_path(self, node_id: str, round_num: int) -> str:
        return f"round_{round_num}/{node_id}.wav"
