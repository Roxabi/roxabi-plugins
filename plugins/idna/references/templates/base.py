import random
from abc import ABC, abstractmethod
from pathlib import Path

_MUTATION_CYCLE = ["amplify", "blend", "refine"]


class BaseTemplate(ABC):
    name: str
    artifact_type: str  # "image" | "audio" | "html" | "text"

    @abstractmethod
    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        """Build params dict for a root pole node."""

    @abstractmethod
    def mutate(self, parent_params: dict, mutation: str, vocabulary: dict, parent_id: str) -> dict:
        """Apply mutation to parent params. Pure math/string, no LLM."""

    @abstractmethod
    def build_prompt(self, params: dict, anchor: str) -> str:
        """Build the full prompt string from params + anchor."""

    @abstractmethod
    def artifact_path(self, node_id: str, round_num: int) -> str:
        """Relative path for the artifact file."""

    def child_mutation_key(self, child_index: int, parent_params: dict, vocabulary: dict, round_num: int, width: int) -> str:
        """Return mutation key for child at given index. Default: amplify/blend/refine cycle."""
        return _MUTATION_CYCLE[child_index % 3]

    def negative_prompt(self) -> str:
        """Negative prompt for image generation. Override in subclasses."""
        return ""

    def render_sync(self, node: dict, session_dir: Path, vocabulary: dict) -> Path:
        """Synchronously render inline templates. Default: None (external rendering)."""
        return None


class AxisTemplate(BaseTemplate):
    """Base for templates that navigate a numeric axis space.

    Vocabulary must contain:
      axes: [{name, low, high}, ...]   — ordered macro→micro
      axis_priority: [name, ...]       — exploration order (defaults to axes order)
      poles: [{name, axis1: 0-1, ...}] — starting points as axis-space vectors

    Each regular child varies TWO axes (primary + secondary). The last child
    slot is always a wildcard that jumps to a random extreme region of the
    space — prevents getting stuck in a local optimum.

    Step size decays at 0.82× per round (slower than before) so meaningful
    differences persist deeper into the tree.
    """

    @abstractmethod
    def _prompt_template(self, anchor: str, tags: str) -> str:
        """Build prompt from anchor and computed axis tags. Implement in subclass."""

    # ── Axis math ─────────────────────────────────────────────────────────────

    def _compute_tags(self, params: dict, axes: list[dict]) -> str:
        """Derive prompt tags from numeric axis values (0.0–1.0).

        Only emits tags for axes with a clear preference (< 0.30 or > 0.70).
        Midpoint axes (0.30–0.70) are skipped — no defining characteristic,
        including both sides produces contradictions that confuse diffusion models.
        """
        parts = []
        for ax in axes:
            name = ax["name"]
            val = params.get(name)
            if val is None:
                continue
            if val < 0.30:
                parts.append(ax["low"])
            elif val > 0.70:
                parts.append(ax["high"])
            # else: midpoint → skip
        return ", ".join(parts)

    def _step(self, parent_id: str) -> float:
        """Step size by parent round:
          round 0 parent → 0.90  (flip to opposite extreme — poles already at 0.05/0.95)
          round 1 parent → 0.40  (large — still exploring)
          round 2 parent → 0.28
          round 3 parent → 0.20  …decays at 0.70× per round
        """
        round_num = parent_id.split(":")[0].count("-")
        if round_num == 0:
            return 0.90
        return round(0.40 * (0.70 ** (round_num - 1)), 4)

    # ── BaseTemplate implementation ───────────────────────────────────────────

    def build_params(self, pole: dict, vocabulary: dict) -> dict:
        axes = vocabulary.get("axes", [])
        params: dict = {"pole_name": pole.get("name", "unnamed")}
        for ax in axes:
            val = pole.get(ax["name"])
            if val is not None:
                params[ax["name"]] = float(val)
        params["_tags"] = self._compute_tags(params, axes)
        return params

    def mutate(self, parent_params: dict, mutation: str, vocabulary: dict, parent_id: str) -> dict:
        """Apply a mutation to parent params.

        Formats:
          axis:{name}:{direction}[+{name2}:{direction2}]  — move 1 or 2 axes
          wildcard                                         — jump to random extreme region
        """
        axes = vocabulary.get("axes", [])
        priority = vocabulary.get("axis_priority", [a["name"] for a in axes])
        params = dict(parent_params)

        if mutation == "wildcard":
            # Deterministic random jump: pick half the axes, push each to an extreme.
            # Use full parent_id (including reroll suffix) so each reroll gets a different wildcard.
            rng = random.Random(hash(parent_id) ^ 0xC0FFEE)
            n_jump = max(2, len(priority) // 2)
            jumped = rng.sample(priority, min(n_jump, len(priority)))
            for axis_name in jumped:
                params[axis_name] = round(rng.choice([0.05, 0.10, 0.90, 0.95]), 2)
            params["pole_name"] = f"{parent_params.get('pole_name', '')}·wildcard"
            params["varied_axis"] = "wildcard"

        elif mutation.startswith("axis:"):
            step = self._step(parent_id)
            import re as _re
            for axis_name, direction in _re.findall(r'(\w+):([+-]1)', mutation[5:]):
                delta = step * (1.0 if direction == "+1" else -1.0)
                current = params.get(axis_name, 0.5)
                new_val = current + delta
                # Skip the dead zone (0.30–0.70 fires no tag): snap to nearest boundary.
                if 0.30 < new_val < 0.70:
                    new_val = 0.70 if delta > 0 else 0.30
                params[axis_name] = round(max(0.0, min(1.0, new_val)), 4)
                arrow = "↑" if direction == "+1" else "↓"
                params["pole_name"] = f"{parent_params.get('pole_name', '')}·{axis_name}{arrow}"
                params["varied_axis"] = axis_name

        params["_tags"] = self._compute_tags(params, axes)
        return params

    def child_mutation_key(self, child_index: int, parent_params: dict, vocabulary: dict, round_num: int, width: int, reroll: int = 0) -> str:
        """Assign each child a mutation key.

        Last slot (child_index == width-1): wildcard — jumps to random extreme.
        All other slots: vary TWO axes (primary + secondary) away from the midpoint
        (toward their nearest extreme). Axis set rotates each round and per reroll.
        """
        axes = vocabulary.get("axes", [])
        priority = vocabulary.get("axis_priority", [a["name"] for a in axes])
        n = len(priority)
        if n == 0:
            return "axis:none:+1"

        # Last slot → wildcard
        if child_index == width - 1:
            return "wildcard"

        # Regular slots: vary 2 axes. Offset by reroll to explore different pairs.
        regular_width = width - 1  # slots available for regular mutations
        base = (round_num * regular_width + child_index + reroll * 3) % n

        primary_name = priority[base % n]
        secondary_name = priority[(base + 1) % n]

        # Cross to the opposite extreme — tests if the user truly prefers that side.
        # Dead zone skip in mutate() ensures the step always lands in a tag-firing zone.
        primary_val = parent_params.get(primary_name, 0.5)
        primary_dir = "+1" if primary_val <= 0.5 else "-1"

        secondary_val = parent_params.get(secondary_name, 0.5)
        secondary_dir = "+1" if secondary_val <= 0.5 else "-1"

        return f"axis:{primary_name}:{primary_dir}+{secondary_name}:{secondary_dir}"

    def build_prompt(self, params: dict, anchor: str) -> str:
        return self._prompt_template(anchor, params.get("_tags", ""))

    def artifact_path(self, node_id: str, round_num: int) -> str:
        return f"round_{round_num}/{node_id}.png"


# ── TOML-driven template ───────────────────────────────────────────────────────

import tomllib as _tomllib
from pathlib import Path as _Path


class TomlAxisTemplate(AxisTemplate):
    """
    AxisTemplate loaded from a TOML config file in IDNA_DIR/types/.

    Auto-discovered: dropping a new .toml file in types/ creates a new type
    without any code change. Axes can be edited at any time — reloaded on
    each session creation.

    Shared axes are defined in types/_shared.toml and referenced by name.
    Type-local [axes.name] definitions override shared ones.
    """

    def __init__(self, config: dict, shared_axes: dict[str, dict]) -> None:
        meta = config.get("meta", {})
        self.name: str = meta.get("name", "unknown")
        self.artifact_type: str = meta.get("artifact_type", "image")

        dims = config.get("dimensions", {})
        self.TREE_WIDTH: int  = dims.get("tree_width", 384)
        self.TREE_HEIGHT: int = dims.get("tree_height", 512)
        self.FINAL_WIDTH: int  = dims.get("final_width", 768)
        self.FINAL_HEIGHT: int = dims.get("final_height", 1024)

        prompt_cfg = config.get("prompt", {})
        self._prompt_tmpl: str = prompt_cfg.get("template", "{anchor}, {tags}")
        self._exclude_axes: set[str] = set(prompt_cfg.get("exclude_axes", []))

        # ── Build merged axes dict ─────────────────────────────────────────────
        # shared_axes list may live under [prompt] (per TOML spec) or at top level.
        shared_refs: list[str] = (
            prompt_cfg.get("shared_axes")
            or config.get("shared_axes", [])
        )
        # Start with shared axes, then overlay type-local axes (local wins).
        merged: dict[str, dict] = {}
        for name in shared_refs:
            if name in shared_axes:
                merged[name] = shared_axes[name]
        merged.update(config.get("axes", {}))

        # ── Apply priority order ───────────────────────────────────────────────
        priority: list[str] = config.get("axis_priority", {}).get("order", list(merged))
        ordered: list[dict] = []
        seen: set[str] = set()
        for k in priority:
            if k in merged and k not in seen:
                ordered.append({"name": k, **merged[k]})
                seen.add(k)
        # Append any axes not mentioned in priority
        for k, v in merged.items():
            if k not in seen:
                ordered.append({"name": k, **v})

        # Expose as class-compatible attributes (used by _random_vocabulary)
        self.DEFAULT_AXES: list[dict] = ordered
        self.DEFAULT_AXIS_PRIORITY: list[str] = [ax["name"] for ax in ordered]
        self.DEFAULT_ANCHOR: str = meta.get("anchor", self.name)

    @classmethod
    def from_file(cls, path: _Path) -> "TomlAxisTemplate":
        """Load a TomlAxisTemplate from a .toml file. Reads _shared.toml sibling."""
        with open(path, "rb") as f:
            config = _tomllib.load(f)
        shared_path = path.parent / "_shared.toml"
        shared_axes: dict[str, dict] = {}
        if shared_path.exists():
            with open(shared_path, "rb") as f:
                shared_cfg = _tomllib.load(f)
            shared_axes = shared_cfg.get("axes", {})
        return cls(config, shared_axes)

    # ── AxisTemplate abstract method implementations ───────────────────────────

    def _compute_tags(self, params: dict, axes: list[dict]) -> str:
        filtered = [a for a in axes if a["name"] not in self._exclude_axes]
        return super()._compute_tags(params, filtered)

    def _prompt_template(self, anchor: str, tags: str) -> str:
        return self._prompt_tmpl.format(anchor=anchor, tags=tags)
