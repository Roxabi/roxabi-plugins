from .base import BaseTemplate


class AvatarTemplate(BaseTemplate):
    name = "avatar"
    artifact_type = "image"

    TREE_WIDTH = 256
    TREE_HEIGHT = 320
    FINAL_WIDTH = 768
    FINAL_HEIGHT = 1024

    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        return {
            "pole_name": pole["name"],
            "tags": list(pole["tags"]),
            "style_string": ", ".join(pole["tags"]),
        }

    def mutate(self, parent_params: dict, mutation: str, vocabulary: dict, parent_id: str) -> dict:
        vocab = vocabulary.get("mutation_vocab", {})
        tags = list(parent_params.get("tags", []))
        pole_name = parent_params.get("pole_name", "")

        if mutation == "amplify":
            mods = vocab.get("amplify_mods", ["extreme", "maximum intensity", "pushed to the limit"])
            mod = mods[hash(parent_id) % len(mods)]
            tags = [f"{t}, {mod}" if i == 0 else t for i, t in enumerate(tags)]
            pole_name = f"{pole_name}-amplified"

        elif mutation == "blend":
            contrast_name = parent_params.get("contrast_pole")
            contrast_tags = []
            for pole in vocabulary.get("poles", []):
                if pole["name"] == contrast_name:
                    contrast_tags = pole["tags"]
                    break
            if contrast_tags:
                n_parent = max(1, int(len(tags) * 0.6))
                n_contrast = max(1, int(len(contrast_tags) * 0.4))
                tags = tags[:n_parent] + contrast_tags[:n_contrast]
            pole_name = f"{pole_name}-blended"

        elif mutation == "refine":
            refiners = vocab.get("refine_mods", ["polished", "cleaner composition", "more natural"])
            mod = refiners[hash(parent_id) % len(refiners)]
            tags = tags + [mod]
            pole_name = f"{pole_name}-refined"

        return {
            "pole_name": pole_name,
            "tags": tags,
            "style_string": ", ".join(tags),
        }

    def build_prompt(self, params: dict, anchor: str) -> str:
        style = params.get("style_string", "")
        return f"{anchor}, {style}, portrait photography, professional"

    def artifact_path(self, node_id: str, round_num: int) -> str:
        return f"round_{round_num}/{node_id}.png"
