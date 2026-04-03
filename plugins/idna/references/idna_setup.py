#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""IDNA Setup — 1 LLM call: user intent → session.json with vocabulary.

Usage:
    python idna_setup.py <session_dir> [--depth 3]

Interactive mode: describe your goal, Claude picks template + vocabulary.
Or pass --template and --anchor to skip the interactive step.
"""

from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path

TEMPLATES_MENU = """
1. color-palette   — hue, saturation, contrast ratios, accent combinations
2. logo            — shape, icon, typography, composition (image gen)
3. writing-tone    — bio, tagline, copy, error messages (Phase 2)
4. ui-component    — button styles, card layouts, spacing, border radius
5. avatar          — facial features, expressions, outfits, art style (image gen)
6. naming          — product names, codenames, phonetics (Phase 2)
7. architecture    — system designs with trade-offs (Phase 2)
8. icon-set        — line weight, fill style, corner radius
9. motion-curve    — easing functions, duration, stagger patterns
"""

PHASE2_TEMPLATES = {"writing-tone", "naming", "architecture"}

SYSTEM = """You are an IDNA session configurator. Given a user's creative goal, you:
1. Pick the best template
2. Write 4 diverse poles (starting points — no two similar, covering the space)
3. Define mutation vocabulary for amplify/blend/refine

Return ONLY valid JSON, no markdown, no explanation."""


def build_setup_prompt(user_intent: str, template: str | None, width: int = 4) -> str:
    template_hint = f"Template: {template}" if template else "Pick from: color-palette, logo, ui-component, avatar, icon-set, motion-curve"

    return f"""User goal: {user_intent}

{template_hint}

Return a session vocabulary JSON:
{{
  "template": "<template-name>",
  "anchor": "<fixed description/context — what stays constant across all variants>",
  "poles": [
    // 4 objects — diverse, no two similar, cover different extremes
    // For image templates (avatar, logo): {{"name": "...", "tags": ["...", "..."], "contrast": "<opposite-pole-name>"}}
    // For voice: {{"name": "...", "pace": 0.0-1.5, "warmth": 0.0-1.0, "energy": 0.0-1.0, "brightness": 0.0-1.0, "contrast": "..."}}
    // For color-palette: {{"name": "...", "primary_hue": 0-360, "saturation": 0.0-1.0, "lightness": 0.3-0.7, "accent_hue": 0-360}}
    // For ui-component: {{"name": "...", "border_radius": 0-32, "shadow_depth": 0.0-1.0, "spacing": 0.5-3.0, "font_weight": 300-700}}
    // For icon-set: {{"name": "...", "stroke_width": 0.5-4.0, "corner_radius": 0-8, "fill": "none|solid|duotone", "size": 16-32}}
    // For motion-curve: {{"name": "...", "x1": 0-1, "y1": 0-2, "x2": 0-1, "y2": 0-2, "duration": 0.1-1.0, "stagger": 0-0.2}}
  ],
  "mutation_vocab": {{
    // Template-specific mutation parameters
    // For image: {{"amplify_mods": ["...", "..."], "refine_mods": ["...", "..."]}}
    // For voice: {{"amplify": {{"scale": 1.3}}, "blend": {{"weight": 0.5}}, "refine": {{"nudge": 0.05}}}}
    // For color-palette: {{"amplify": {{"saturation": 0.15, "contrast": 0.1}}, "blend": {{"weight": 0.5}}, "refine": {{"saturation": -0.08}}}}
    // For ui-component: use numeric deltas
    // For icon-set: use numeric deltas
    // For motion-curve: use numeric deltas
  }}
}}"""


def call_claude(user_msg: str) -> dict:
    result = subprocess.run(
        ["claude", "-p", user_msg,
         "--system-prompt", SYSTEM,
         "--output-format", "text",
         "--max-turns", "1"],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise RuntimeError(f"claude CLI exited {result.returncode}: {result.stderr.strip()}")
    raw = result.stdout.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    return json.loads(raw)


def setup_session(session_dir: Path, depth: int, width: int, intent: str | None, template: str | None, anchor: str | None) -> None:
    session_dir.mkdir(parents=True, exist_ok=True)
    session_file = session_dir / "session.json"

    if session_file.exists():
        existing = json.loads(session_file.read_text())
        if existing.get("vocabulary"):
            print(f"Session already has vocabulary ({existing.get('template')}). Use --reset to overwrite.")
            sys.exit(0)

    if not intent:
        print("What do you want to select/explore?")
        print(TEMPLATES_MENU)
        intent = input("Describe your goal: ").strip()
        if not intent:
            print("No intent provided.", file=sys.stderr)
            sys.exit(1)

    if template and template in PHASE2_TEMPLATES:
        print(f"Template '{template}' is Phase 2 (requires LLM per node). Not available yet.")
        sys.exit(1)

    print(f"\nCalling Claude to set up vocabulary ({width} poles)...")
    vocab_data = call_claude(build_setup_prompt(intent, template, width))

    chosen_template = vocab_data.get("template", template or "avatar")
    if chosen_template in PHASE2_TEMPLATES:
        print(f"Claude chose Phase 2 template '{chosen_template}'. Please clarify your goal.")
        sys.exit(1)

    poles = vocab_data.get("poles", [])[:width]

    session = {
        "id": f"{session_dir.parent.name}-{session_dir.name}-001",
        "template": chosen_template,
        "anchor": vocab_data.get("anchor", anchor or intent),
        "width": width,
        "vocabulary": {
            "poles": poles,
            "mutation_vocab": vocab_data.get("mutation_vocab", {}),
            "round_focus": vocab_data.get("round_focus", []),
        },
        "depth": depth,
    }

    session_file.write_text(json.dumps(session, indent=2))
    print(f"\nVocabulary written to {session_file}")
    print(f"  Template:  {chosen_template}")
    print(f"  Anchor:    {session['anchor']}")
    print(f"  Poles:     {', '.join(p['name'] for p in session['vocabulary']['poles'])}")
    print(f"\nNext: python idna_build_tree.py {session_dir}")


def main():
    parser = argparse.ArgumentParser(description="IDNA Setup — vocabulary from intent")
    parser.add_argument("session_dir", help="Path to session dir")
    parser.add_argument("--depth", type=int, default=3, choices=[1, 2, 3, 4, 5])
    parser.add_argument("--width", type=int, default=4, choices=[3, 4, 5])
    parser.add_argument("--intent", help="Goal description (skip interactive prompt)")
    parser.add_argument("--template", help="Force template choice")
    parser.add_argument("--anchor", help="Force anchor text")
    args = parser.parse_args()
    setup_session(
        Path(args.session_dir).expanduser().resolve(),
        args.depth, args.width, args.intent, args.template, args.anchor,
    )


if __name__ == "__main__":
    main()
