from .base import BaseTemplate


class LogoTemplate(BaseTemplate):
    name = "logo"
    artifact_type = "image"

    TREE_WIDTH = 256
    TREE_HEIGHT = 256
    FINAL_WIDTH = 1024
    FINAL_HEIGHT = 1024

    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        return {
            "pole_name": pole["name"],
            "tags": list(pole["tags"]),
            "style_string": ", ".join(pole["tags"]),
        }

    def mutate(self, parent_params, mutation, vocabulary, parent_id):
        from .avatar import AvatarTemplate
        return AvatarTemplate().mutate(parent_params, mutation, vocabulary, parent_id)

    def build_prompt(self, params: dict, anchor: str) -> str:
        style = params.get("style_string", "")
        return f"logo design for {anchor}, {style}, vector art, clean background, professional branding"

    def artifact_path(self, node_id: str, round_num: int) -> str:
        return f"round_{round_num}/{node_id}.png"
