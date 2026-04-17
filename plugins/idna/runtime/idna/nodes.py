"""Node helpers: children, mutations, job files, encode/daemon job builders."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from .config import (
    IDNA_DIR,
    TREE_WIDTH,
    TREE_HEIGHT,
    FINAL_WIDTH,
    FINAL_HEIGHT,
    _CHILD_SUFFIXES,
    _RATIOS,
    log,
)
from .daemon import _daemon_blend


def _node_round(node_id: str) -> int:
    """Return round number from node id (e.g. 'v0-va-vb' -> 2)."""
    return node_id.count("-")


def _blend_pole_embeds(sdir: Path, node_id: str, session: dict) -> bool:
    """Write a blended .pt for node_id by interpolating pole embeddings via daemon.

    Blend weights = softmax(-L2_distance_in_axis_space * temperature).
    Delegates tensor math to the imageCLI daemon (which has torch loaded).
    Requires poles encoded to sdir/poles/{i}.pt.
    Returns True on success.
    """
    import math

    nodes = session.get("nodes", {})
    node = nodes.get(node_id)
    if not node:
        log.error("_blend_pole_embeds: node %r not found", node_id)
        return False

    vocabulary = session.get("vocabulary", {})
    poles = vocabulary.get("poles", [])
    axis_names = [a["name"] for a in vocabulary.get("axes", [])]
    node_params = node.get("params", {})

    if not poles or not axis_names:
        log.error("_blend_pole_embeds: no poles or axes in vocabulary")
        return False

    # Verify pole embeds exist
    for i in range(len(poles)):
        pt_path = sdir / "poles" / f"{i}.pt"
        if not pt_path.exists():
            log.error("_blend_pole_embeds: missing pole embed %s", pt_path)
            return False

    # Determine which axes to use for distance computation.
    # For axis mutations: use only the varied axes so that flipping 2 axes out of 19
    # doesn't collapse all weights onto the parent pole (which shares 17/19 axes).
    # For wildcard: use all axes (no specific direction).
    import re as _re
    mutation = node.get("mutation", "")
    if mutation.startswith("axis:"):
        varied = _re.findall(r'(\w+):[+-]1', mutation[5:])
        active_indices = [i for i, a in enumerate(axis_names) if a in varied]
    else:
        active_indices = list(range(len(axis_names)))

    if not active_indices:
        active_indices = list(range(len(axis_names)))

    n_active = len(active_indices)
    node_vec = [float(node_params.get(axis_names[i], 0.5)) for i in active_indices]

    # Compute softmax(-L2_normalized * temperature) weights in pure Python.
    # Normalize distance by sqrt(n_active) so sharpness is consistent regardless
    # of how many axes are used (2 varied axes vs 19 all axes).
    temperature = 4.0
    dists = [
        math.sqrt(sum((node_vec[k] - float(p.get(axis_names[active_indices[k]], 0.5))) ** 2
                      for k in range(n_active))) / math.sqrt(n_active)
        for p in poles
    ]
    raw = [math.exp(-d * temperature) for d in dists]
    total = sum(raw)
    weights = [w / total for w in raw]

    log.info("_blend_pole_embeds %s: varied=%s top_pole=%d (%.2f%%)",
             node_id, varied if mutation.startswith("axis:") else "all",
             weights.index(max(weights)), max(weights) * 100)

    round_num = node["round"]
    embed_path = sdir / f"round_{round_num}" / "embeds" / f"{node_id}.pt"
    embed_path.parent.mkdir(parents=True, exist_ok=True)

    inputs = [
        {"path": str(sdir / "poles" / f"{i}.pt"), "weight": weights[i]}
        for i in range(len(poles))
    ]
    result = _daemon_blend(inputs, str(embed_path))
    if not result.get("ok"):
        log.error("_blend_pole_embeds: daemon blend failed for %s: %s", node_id, result.get("error"))
        return False
    return True


def _node_children_ids(node_id: str, width: int = 3) -> list[str]:
    """Return child ids for a given node based on session width."""
    return [f"{node_id}-{_CHILD_SUFFIXES[i]}" for i in range(width)]


def _nudge_call(params: dict, vocabulary: dict, text: str) -> dict | None:
    """Call Claude to map user creative direction text to axis deltas dict.

    Returns e.g. {"weight": 0.3, "geometry": -0.2} or None on failure.
    """
    axes = vocabulary.get("axes", [])
    if not axes:
        return None
    axis_descriptions = "\n".join(
        f'- {a["name"]}: {params.get(a["name"], 0.5):.2f}  (0="{a["low"]}" \u2192 1="{a["high"]}")'
        for a in axes if a["name"] in params
    )
    prompt = f"""Current axis values:
{axis_descriptions}

User direction: "{text}"

Return ONLY a JSON object mapping axis names to deltas (-0.4 to +0.4).
Only include axes that should change. Example: {{"weight": 0.3, "geometry": -0.2}}"""

    try:
        result = subprocess.run(
            ["claude", "-p", prompt,
             "--system-prompt", "You are an axis adjuster. Map user creative direction to numeric axis deltas. Return only valid JSON.",
             "--output-format", "text", "--max-turns", "1"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            log.error("_nudge_call: claude exited %d: %s", result.returncode, result.stderr.strip())
            return None
        raw = result.stdout.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()
        return json.loads(raw)  # type: ignore[no-any-return]
    except Exception as exc:
        log.error("_nudge_call failed: %s", exc)
        return None


def _ratio_dims(session: dict, tmpl: object, final: bool = False) -> tuple[int, int]:
    """Compute image dimensions from session ratio + template base size."""
    ratio_str = session.get("ratio", "")
    if final:
        base_w = getattr(tmpl, "FINAL_WIDTH", FINAL_WIDTH)
        base_h = getattr(tmpl, "FINAL_HEIGHT", FINAL_HEIGHT)
    else:
        base_w = getattr(tmpl, "TREE_WIDTH", TREE_WIDTH)
        base_h = getattr(tmpl, "TREE_HEIGHT", TREE_HEIGHT)
    if ratio_str in _RATIOS:
        rw, rh = _RATIOS[ratio_str]
        h = round((base_w * rh / rw) / 64) * 64
        return base_w, max(h, 64)
    return base_w, base_h


def _ensure_job_file(sdir: Path, node: dict, session: dict | None = None) -> None:
    """Write job JSON for a node if it doesn't exist yet."""
    round_num = node["round"]
    prompts_dir = sdir / f"round_{round_num}" / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    job_file = prompts_dir / f"{node['id']}.json"
    if not job_file.exists():
        seed_base = round_num * 100
        mutation_idx = {s: i for i, s in enumerate(_CHILD_SUFFIXES)}
        suffix = node["id"].rsplit("-", 1)[-1] if "-" in node["id"] else node["id"].lstrip("v")
        if suffix in mutation_idx:
            seed = seed_base + mutation_idx[suffix]
        else:
            seed = int(suffix) if suffix.isdigit() else 0
        w, h = TREE_WIDTH, TREE_HEIGHT
        if session:
            try:
                sys.path.insert(0, str(IDNA_DIR))
                from templates import get_template  # type: ignore[import-not-found]
                tmpl = get_template(session.get("template", "avatar"))
                w, h = _ratio_dims(session, tmpl, final=False)
            except Exception:
                pass
        job = {
            "id": node["id"],
            "label": node["label"],
            "mutation": node.get("mutation"),
            "seed": seed,
            "width": w,
            "height": h,
            "prompt": node["prompt"],
        }
        job_file.write_text(json.dumps(job, indent=2))


def _create_child_nodes(
    sdir: Path,
    parent_id: str,
    session: dict,
    override_params: dict | None = None,
    seed_suffix: str = "",
) -> dict:
    """Create child nodes for parent_id on demand if they don't exist yet.

    Uses the same mutation logic as idna_build_tree.py. Makes the tree
    infinitely extensible — nodes are created lazily as you pick deeper.

    override_params: if set, use these params as the mutation base instead of
                     the parent's stored params (used by nudge to shift starting point).

    Returns the updated session dict (caller must write_session).
    """
    nodes = session.get("nodes", {})
    parent_node = nodes.get(parent_id)
    if not parent_node:
        return session

    sys.path.insert(0, str(IDNA_DIR))
    try:
        from templates import get_template  # type: ignore[import-not-found]
        tmpl = get_template(session.get("template", "avatar"))
    except Exception as exc:
        log.error("_create_child_nodes: failed to load template: %s", exc)
        return session

    vocabulary = session.get("vocabulary", {})
    anchor = session.get("anchor", "")
    width = session.get("width", 3)
    child_round = parent_node["round"] + 1
    base_params = override_params if override_params is not None else parent_node["params"]
    parent_round = parent_node["round"]

    reroll_n = 0
    if seed_suffix.startswith(":r"):
        try:
            reroll_n = int(seed_suffix[2:])
        except ValueError:
            pass

    # ── Try PBO suggestion ────────────────────────────────────────────────────
    pbo_params_list: list[dict] | None = None
    if not seed_suffix or seed_suffix.startswith(":r"):  # not a nudge
        try:
            from .pbo import suggest_candidates
            _axis_names = [ax["name"] for ax in vocabulary.get("axes", [])]
            _seed = hash(parent_id + seed_suffix) & 0x7FFFFFFF
            pbo_params_list = suggest_candidates(session, width, _axis_names, seed=_seed)
        except Exception:
            pbo_params_list = None

    for i in range(width):
        suffix = _CHILD_SUFFIXES[i]
        child_id = f"{parent_id}-{suffix}"
        if child_id in nodes and override_params is None and not seed_suffix:
            continue

        # ── PBO path ──────────────────────────────────────────────────────────
        if pbo_params_list and i < len(pbo_params_list):
            pbo_p = pbo_params_list[i]
            axes_list = vocabulary.get("axes", [])
            if hasattr(tmpl, "_compute_tags"):
                pbo_p["_tags"] = tmpl._compute_tags(pbo_p, axes_list)
            try:
                prompt = tmpl.build_prompt(pbo_p, anchor)
            except Exception:
                prompt = ""
            # Find the most varied axis vs parent for display
            parent_p = parent_node.get("params", {})
            _axis_names_local = [ax["name"] for ax in axes_list]
            deltas = {
                k: abs(float(pbo_p.get(k, 0.5)) - float(parent_p.get(k, 0.5)))
                for k in _axis_names_local
            }
            if deltas:
                pbo_p["varied_axis"] = max(deltas, key=deltas.get)
            nodes[child_id] = {
                "id": child_id,
                "round": child_round,
                "parent": parent_id,
                "mutation": "pbo",
                "label": suffix.upper(),
                "params": pbo_p,
                "prompt": prompt,
                "artifact": tmpl.artifact_path(child_id, child_round),
                "status": "pending",
                "anchor": anchor,
            }
            _ensure_job_file(sdir, nodes[child_id], session)
            log.info("PBO node %s (round %d)", child_id, child_round)
            continue  # skip mutation path

        mutation = tmpl.child_mutation_key(i, base_params, vocabulary, parent_round, width, reroll=reroll_n)
        # Salt only for legacy (non-axis) templates
        salt = "" if mutation.startswith("axis:") else (f":{i // 3}" if i >= 3 else "")
        try:
            params = tmpl.mutate(base_params, mutation, vocabulary, parent_id + salt + seed_suffix)
            prompt = tmpl.build_prompt(params, anchor)
        except Exception as exc:
            log.error("_create_child_nodes: mutation failed for %s: %s", child_id, exc)
            continue
        nodes[child_id] = {
            "id": child_id,
            "round": child_round,
            "parent": parent_id,
            "mutation": mutation,
            "label": suffix.upper(),
            "params": params,
            "prompt": prompt,
            "artifact": tmpl.artifact_path(child_id, child_round),
            "status": "pending",
            "anchor": anchor,
        }
        _ensure_job_file(sdir, nodes[child_id], session)
        log.info("Created on-demand node %s (round %d, mutation=%s)", child_id, child_round, mutation)

    session["nodes"] = nodes
    return session


def _build_encode_jobs(sdir: Path, node_ids: list[str], session: dict) -> list[dict]:
    """Build encode job dicts for nodes that need embedding."""
    jobs: list[dict] = []
    nodes = session.get("nodes", {})
    for nid in node_ids:
        node = nodes.get(nid)
        if not node:
            continue
        round_num = node["round"]
        job_file = sdir / f"round_{round_num}" / "prompts" / f"{nid}.json"
        embed_path = sdir / f"round_{round_num}" / "embeds" / f"{nid}.pt"
        prompt = node.get("prompt", "")
        negative_prompt = ""
        if job_file.exists():
            try:
                jf = json.loads(job_file.read_text())
                prompt = jf.get("prompt", prompt)
                negative_prompt = jf.get("negative_prompt", "")
            except Exception:
                pass
        entry: dict = {"id": nid, "prompt": prompt, "embed_path": str(embed_path)}
        if negative_prompt:
            entry["negative_prompt"] = negative_prompt
        jobs.append(entry)
    return jobs


def _build_daemon_jobs(
    sdir: Path,
    node_ids: list[str],
    session: dict,
    steps: int = 15,
) -> list[dict]:
    """Build daemon job dicts from node IDs, reading job files for metadata."""
    jobs: list[dict] = []
    nodes = session.get("nodes", {})
    for nid in node_ids:
        node = nodes.get(nid)
        if not node:
            continue
        round_num = node["round"]
        round_dir = sdir / f"round_{round_num}"
        embed_path = round_dir / "embeds" / f"{nid}.pt"
        out_path = round_dir / f"{nid}.png"
        job_file = round_dir / "prompts" / f"{nid}.json"
        jdata = json.loads(job_file.read_text()) if job_file.exists() else {}
        jobs.append({
            "id": nid,
            "embed_path": str(embed_path),
            "out_path": str(out_path),
            "seed": jdata.get("seed", round_num * 100),
            "width": jdata.get("width", TREE_WIDTH),
            "height": jdata.get("height", TREE_HEIGHT),
            "steps": steps,
        })
    return jobs
