from abc import ABC, abstractmethod
from pathlib import Path


class BaseTemplate(ABC):
    name: str
    artifact_type: str  # "image" | "audio" | "html" | "text"

    @abstractmethod
    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        """Build params dict for a root pole node."""

    @abstractmethod
    def mutate(self, parent_params: dict, mutation: str, vocabulary: dict, parent_id: str) -> dict:
        """Apply amplify/blend/refine mutation to parent params. Pure math/string, no LLM."""

    @abstractmethod
    def build_prompt(self, params: dict, anchor: str) -> str:
        """Build the full prompt/render-args string from params + anchor."""

    @abstractmethod
    def artifact_path(self, node_id: str, round_num: int) -> str:
        """Relative path for the artifact file."""

    def render_sync(self, node: dict, session_dir: Path, vocabulary: dict) -> Path:
        """
        Synchronously render a node to its artifact.
        Default: returns None (server handles rendering externally).
        Override for templates that can render inline (colors, text, etc).
        """
        return None
