#!/usr/bin/env python3
# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""IDNA tree builder — pure script, no LLM. Builds all nodes from vocabulary.

Usage:
    python idna_build_tree.py <session_dir> [--depth 3]

Reads session.json (must have 'vocabulary' from idna_setup.py).
Writes all node params/prompts + job files. Zero LLM calls.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# ── Tree structure helpers ────────────────────────────────────────────────────

MUTATIONS = [("va", "amplify"), ("vb", "blend"), ("vc", "refine")]


def node_count(depth: int) -> int:
    return sum(4 * (3 ** r) for r in range(depth + 1))


def round_nodes(round_num: int) -> list[str]:
    if round_num == 0:
        return [f"v{i}" for i in range(4)]
    parents = round_nodes(round_num - 1)
    return [f"{p}-{suffix}" for p in parents for suffix, _ in MUTATIONS]


def node_seed(node_id: str) -> int:
    round_num = node_id.count("-")
    if round_num == 0:
        return int(node_id[1:])
    suffix = node_id.rsplit("-", 1)[1]
    return round_num * 100 + {"va": 0, "vb": 1, "vc": 2}[suffix]


def node_parent(node_id: str) -> str | None:
    return node_id.rsplit("-", 1)[0] if "-" in node_id else None


def node_mutation(node_id: str) -> str | None:
    if "-" not in node_id:
        return None
    return {"va": "amplify", "vb": "blend", "vc": "refine"}.get(node_id.rsplit("-", 1)[1])


def node_label(node_id: str) -> str:
    if "-" not in node_id:
        return f"V{node_id[1:]}"
    suffix = node_id.rsplit("-", 1)[1]
    return {"va": "Va", "vb": "Vb", "vc": "Vc"}[suffix]


# ── Tree builder ──────────────────────────────────────────────────────────────

def build_tree(session_dir: Path, depth: int) -> None:
    session_file = session_dir / "session.json"
    session = json.loads(session_file.read_text())

    vocabulary = session.get("vocabulary")
    if not vocabulary:
        print("ERROR: session.json missing 'vocabulary'. Run idna_setup.py first.", file=sys.stderr)
        sys.exit(1)

    template_name = session.get("template", "avatar")
    anchor = session.get("anchor", "")

    sys.path.insert(0, str(Path(__file__).parent))
    from templates import get_template
    tmpl = get_template(template_name)

    poles = vocabulary.get("poles", [])
    if len(poles) < 4:
        print(f"ERROR: vocabulary needs 4 poles, got {len(poles)}", file=sys.stderr)
        sys.exit(1)

    total = node_count(depth)
    print(f"IDNA tree builder — template={template_name}, depth={depth}, total={total} nodes (0 LLM calls)")
    print()

    nodes = session.get("nodes", {})

    # Build round 0 from poles
    for i, node_id in enumerate(round_nodes(0)):
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

    # Build subsequent rounds via mutation
    for round_num in range(1, depth + 1):
        for node_id in round_nodes(round_num):
            if node_id in nodes:
                continue
            parent_id = node_parent(node_id)
            mutation = node_mutation(node_id)
            parent_params = nodes[parent_id]["params"]
            params = tmpl.mutate(parent_params, mutation, vocabulary, parent_id)
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

    # Write job files (for image/audio templates that need external rendering)
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

    # BFS queue
    bfs_queue = [nid for r in range(depth + 1) for nid in round_nodes(r) if nid in nodes]

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
    print(f"Template: {template_name} ({tmpl.artifact_type})")

    if tmpl.artifact_type == "image":
        print(f"\nNext steps:")
        print(f"  1. uv run --project ~/projects/imageCLI python idna_encode_all.py {session_dir}")
        print(f"  2. make idna start  (server auto-BFS generates images)")
        print(f"  3. open http://localhost:8082/{session_dir.parent.name}/{session_dir.name}/")
    elif tmpl.artifact_type == "audio":
        print(f"\nNext steps:")
        print(f"  1. make idna start  (server generates audio via voiceCLI)")
        print(f"  2. open http://localhost:8082/{session_dir.parent.name}/{session_dir.name}/")
    else:
        print(f"\nAll artifacts rendered. Open:")
        print(f"  make idna start")
        print(f"  open http://localhost:8082/{session_dir.parent.name}/{session_dir.name}/")


def main():
    parser = argparse.ArgumentParser(description="Build IDNA prompt tree (no LLM)")
    parser.add_argument("session_dir", help="Path to session dir")
    parser.add_argument("--depth", type=int, default=3, choices=[1, 2, 3, 4])
    args = parser.parse_args()
    build_tree(Path(args.session_dir).expanduser().resolve(), args.depth)


if __name__ == "__main__":
    main()
