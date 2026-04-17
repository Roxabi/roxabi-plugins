#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""IDNA tree builder — pure script, no LLM. Builds all nodes from vocabulary.

Usage:
    python idna_build_tree.py <session_dir> [--depth 3]

Reads session.json (must have 'vocabulary' from idna_setup.py).
Width is read from session.json (set by idna_setup.py).
Writes all node params/prompts + job files. Zero LLM calls.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# ── Tree structure helpers ────────────────────────────────────────────────────

_CHILD_SUFFIXES = ["va", "vb", "vc", "vd", "ve", "vf", "vg", "vh", "vi"]


def node_count(depth: int, width: int) -> int:
    return sum(width * (width ** r) for r in range(depth + 1))


def round_nodes(round_num: int, width: int) -> list[str]:
    if round_num == 0:
        return [f"v{i}" for i in range(width)]
    parents = round_nodes(round_num - 1, width)
    return [f"{p}-{_CHILD_SUFFIXES[i]}" for p in parents for i in range(width)]


def node_seed(node_id: str) -> int:
    round_num = node_id.count("-")
    if round_num == 0:
        return int(node_id[1:])
    suffix = node_id.rsplit("-", 1)[1]
    idx = _CHILD_SUFFIXES.index(suffix) if suffix in _CHILD_SUFFIXES else 0
    return round_num * 100 + idx


def node_parent(node_id: str) -> str | None:
    return node_id.rsplit("-", 1)[0] if "-" in node_id else None


def node_label(node_id: str) -> str:
    if "-" not in node_id:
        return f"V{node_id[1:]}"
    return node_id.rsplit("-", 1)[1].upper()


# ── Tree builder ──────────────────────────────────────────────────────────────

def build_tree(session_dir: Path, depth: int) -> None:
    session_file = session_dir / "session.json"
    session = json.loads(session_file.read_text())

    vocabulary = session.get("vocabulary")
    if not vocabulary:
        print("ERROR: session.json missing 'vocabulary'. Run idna_setup.py first.", file=sys.stderr)
        sys.exit(1)

    width = session.get("width", 3)
    template_name = session.get("template", "avatar")
    anchor = session.get("anchor", "")

    sys.path.insert(0, str(Path(__file__).parent))
    from templates import get_template
    tmpl = get_template(template_name)

    poles = vocabulary.get("poles", [])
    if len(poles) < width:
        print(f"ERROR: vocabulary needs {width} poles, got {len(poles)}", file=sys.stderr)
        sys.exit(1)

    total = node_count(depth, width)
    print(f"IDNA tree builder — template={template_name}, depth={depth}, width={width}, total={total} nodes (0 LLM calls)")
    print()

    nodes = session.get("nodes", {})

    # Build round 0 from poles
    for i, node_id in enumerate(round_nodes(0, width)):
        if node_id in nodes:
            continue
        pole = poles[i]
        params = tmpl.build_params(pole, vocabulary)
        prompt = tmpl.build_prompt(params, anchor)
        nodes[node_id] = {
            "id": node_id,
            "round": 0,
            "parent": None,
            "mutation": None,
            "label": node_label(node_id),
            "params": params,
            "prompt": prompt,
            "artifact": tmpl.artifact_path(node_id, 0),
            "status": "pending",
            "anchor": anchor,
        }

    # Build subsequent rounds via axis mutation
    for round_num in range(1, depth + 1):
        for node_id in round_nodes(round_num, width):
            if node_id in nodes:
                continue
            parent_id = node_parent(node_id)
            suffix = node_id.rsplit("-", 1)[1]
            child_index = _CHILD_SUFFIXES.index(suffix) if suffix in _CHILD_SUFFIXES else 0
            parent_params = nodes[parent_id]["params"]
            parent_round = round_num - 1  # parent is one round up

            # Use template's child_mutation_key (axis-aware for image templates)
            mutation = tmpl.child_mutation_key(child_index, parent_params, vocabulary, parent_round, width)

            # Salt only for legacy (non-axis) templates to vary hash-based selection
            salt = "" if mutation.startswith("axis:") else (f":{child_index // 3}" if child_index >= 3 else "")
            params = tmpl.mutate(parent_params, mutation, vocabulary, parent_id + salt)
            prompt = tmpl.build_prompt(params, anchor)
            nodes[node_id] = {
                "id": node_id,
                "round": round_num,
                "parent": parent_id,
                "mutation": mutation,
                "label": node_label(node_id),
                "params": params,
                "prompt": prompt,
                "artifact": tmpl.artifact_path(node_id, round_num),
                "status": "pending",
                "anchor": anchor,
            }

    print(f"  → {len(nodes)} nodes built from vocabulary")

    # Write job files
    print(f"\nWriting job files...")
    for nid, node in nodes.items():
        round_num = node["round"]
        prompts_dir = session_dir / f"round_{round_num}" / "prompts"
        prompts_dir.mkdir(parents=True, exist_ok=True)
        (session_dir / f"round_{round_num}" / "embeds").mkdir(exist_ok=True)
        job_file = prompts_dir / f"{nid}.json"
        if not job_file.exists():
            w = getattr(tmpl, "TREE_WIDTH", 384)
            h = getattr(tmpl, "TREE_HEIGHT", 512)
            job = {
                "id": nid,
                "label": node["label"],
                "mutation": node.get("mutation"),
                "seed": node_seed(nid),
                "width": w,
                "height": h,
                "prompt": node["prompt"],
                "template": template_name,
                "artifact_type": tmpl.artifact_type,
            }
            job_file.write_text(json.dumps(job, indent=2))
    print(f"  → {len(nodes)} job files written")

    # For inline-render templates (html, text), render all nodes immediately
    if tmpl.artifact_type in ("html", "text"):
        print(f"\nRendering inline artifacts ({tmpl.artifact_type})...")
        rendered = 0
        for nid, node in nodes.items():
            artifact_path = session_dir / node["artifact"]
            if not artifact_path.exists():
                result = tmpl.render_sync(node, session_dir, vocabulary)
                if result:
                    nodes[nid]["status"] = "ready"
                    rendered += 1
            else:
                nodes[nid]["status"] = "ready"
        print(f"  → {rendered} artifacts rendered")

    # BFS queue (round 0 only — subsequent rounds generated on demand)
    bfs_queue = list(round_nodes(0, width))

    # Save session
    session["nodes"] = nodes
    session["queue"] = bfs_queue
    session["depth"] = depth
    session["phase"] = "picking"
    session["path"] = session.get("path", [])
    session["gen_status"] = "ready" if tmpl.artifact_type in ("html", "text") else "generating"
    session["winner"] = session.get("winner")
    session.pop("rounds", None)
    session_file.write_text(json.dumps(session, indent=2))

    print(f"\nDone. {len(nodes)}/{total} nodes built.")
    print(f"Template: {template_name} ({tmpl.artifact_type}), width={width}")

    if tmpl.artifact_type == "image":
        print(f"\nNext steps:")
        print(f"  1. make idna start  (server encodes+generates lazily per pick)")
        print(f"  2. open http://localhost:8082/{session_dir.parent.name}/{session_dir.name}/")


def main():
    parser = argparse.ArgumentParser(description="Build IDNA prompt tree (no LLM)")
    parser.add_argument("session_dir", help="Path to session dir")
    parser.add_argument("--depth", type=int, default=3)
    args = parser.parse_args()
    build_tree(Path(args.session_dir).expanduser().resolve(), args.depth)


if __name__ == "__main__":
    main()
