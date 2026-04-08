"""POST API endpoint handlers for IDNA sessions."""

from __future__ import annotations

import shutil
import sys
import threading
from typing import TYPE_CHECKING

from .config import IDNA_DIR
from .generation import _ensure_worker
from .nodes import _create_child_nodes, _node_children_ids, _node_round, _nudge_call
from .session import _is_new_format, _session_dir, read_session, write_session
from .hires import _regen_winner_hires

if TYPE_CHECKING:
    from .server import IDNAHandler


def handle_pick(handler: "IDNAHandler", project: str, subject: str, body: dict) -> None:
    node_id = body.get("node_id")
    if not node_id:
        handler._json(400, {"error": "node_id required"})
        return
    session = read_session(project, subject)
    if not _is_new_format(session):
        handler._json(422, {"error": "legacy session format — rebuild tree first"})
        return
    nodes = session.get("nodes", {})
    if node_id not in nodes:
        handler._json(404, {"error": f"node {node_id!r} not found"})
        return
    node = nodes[node_id]
    if node.get("status") != "ready":
        handler._json(409, {"error": f"node {node_id!r} not ready (status: {node.get('status')})"})
        return
    path_list = session.get("path", [])
    expected_round = len(path_list)
    if node["round"] != expected_round:
        handler._json(409, {"error": f"node round {node['round']} != expected {expected_round}"})
        return
    path_list.append(node_id)
    # Record pairwise comparison for PBO
    all_round_nodes = [nid for nid, n in nodes.items() if n.get("round") == node["round"]]
    losers = [nid for nid in all_round_nodes if nid != node_id]
    session.setdefault("comparisons", []).append({
        "round": node["round"],
        "winner": node_id,
        "losers": losers,
    })
    session["path"] = path_list
    width = session.get("width", 3)
    children = _node_children_ids(node_id, width)
    queue = session.get("queue", [])
    remaining = [nid for nid in queue if nid not in children]
    next_round = node["round"] + 1
    insert_at = 0
    for i, qid in enumerate(remaining):
        if nodes.get(qid, {}).get("round", 0) >= next_round:
            insert_at = i
            break
        insert_at = i + 1
    for c in reversed(children):
        if c in nodes:
            remaining.insert(insert_at, c)
    session["queue"] = remaining
    write_session(project, subject, session)
    _ensure_worker(project, subject)
    handler._json(200, {"ok": True, "picked": node_id, "path": path_list})


def handle_back(handler: "IDNAHandler", project: str, subject: str) -> None:
    session = read_session(project, subject)
    if not _is_new_format(session):
        handler._json(422, {"error": "legacy format"})
        return
    path_list = session.get("path", [])
    if not path_list:
        handler._json(400, {"error": "path is already empty"})
        return
    path_list.pop()
    session["path"] = path_list
    write_session(project, subject, session)
    handler._json(200, {"ok": True, "path": path_list})


def handle_reroll(handler: "IDNAHandler", project: str, subject: str) -> None:
    sdir = _session_dir(project, subject)
    session = read_session(project, subject)
    if not _is_new_format(session):
        handler._json(422, {"error": "legacy format"})
        return
    path_list = session.get("path", [])
    if not path_list:
        handler._json(400, {"error": "nothing to reroll — no picks yet"})
        return
    parent_id = path_list[-1]
    nodes = session.get("nodes", {})
    parent_node = nodes.get(parent_id, {})
    reroll_n = parent_node.get("reroll", 0) + 1
    parent_node["reroll"] = reroll_n
    nodes[parent_id] = parent_node
    width = session.get("width", 3)
    children = _node_children_ids(parent_id, width)
    for cid in children:
        nodes.pop(cid, None)
        r = _node_round(cid)
        for fpath in [
            sdir / f"round_{r}" / f"{cid}.png",
            sdir / f"round_{r}" / "embeds" / f"{cid}.pt",
            sdir / f"round_{r}" / "prompts" / f"{cid}.json",
        ]:
            fpath.unlink(missing_ok=True)
    session["queue"] = [nid for nid in session.get("queue", []) if nid not in children]
    session["nodes"] = nodes
    session = _create_child_nodes(sdir, parent_id, session, seed_suffix=f":r{reroll_n}")
    new_children = _node_children_ids(parent_id, width)
    session["queue"] = new_children + [nid for nid in session.get("queue", []) if nid not in new_children]
    write_session(project, subject, session)
    _ensure_worker(project, subject)
    handler._json(200, {"ok": True, "reroll": reroll_n, "parent": parent_id})


def handle_finalize(handler: "IDNAHandler", project: str, subject: str) -> None:
    session = read_session(project, subject)
    if not _is_new_format(session):
        handler._json(422, {"error": "legacy format"})
        return
    path_list = session.get("path", [])
    if not path_list:
        handler._json(400, {"error": "no picks yet — pick at least one node first"})
        return
    winner_id = path_list[-1]
    session["winner"] = winner_id
    session["phase"] = "finalizing"
    write_session(project, subject, session)
    threading.Thread(
        target=_regen_winner_hires, args=(project, subject, winner_id), daemon=True,
    ).start()
    handler._json(200, {"ok": True, "winner": winner_id, "regenerating": True})


def handle_reset(handler: "IDNAHandler", project: str, subject: str) -> None:
    session = read_session(project, subject)
    session["path"] = []
    session.pop("winner", None)
    session["phase"] = "picking"
    session["gen_status"] = "idle"
    write_session(project, subject, session)
    handler._json(200, {"ok": True})


def handle_delete(handler: "IDNAHandler", project: str, subject: str) -> None:
    sdir = _session_dir(project, subject)
    shutil.rmtree(sdir, ignore_errors=True)
    handler._json(200, {"ok": True})


def handle_nudge(handler: "IDNAHandler", project: str, subject: str, body: dict) -> None:
    sdir = _session_dir(project, subject)
    session = read_session(project, subject)
    if not _is_new_format(session):
        handler._json(422, {"error": "legacy format"})
        return
    vocabulary = session.get("vocabulary", {})
    if not vocabulary.get("axes"):
        handler._json(400, {"error": "session does not use axis navigation (no axes defined)"})
        return
    text = body.get("text", "").strip()
    if not text:
        handler._json(400, {"error": "text required"})
        return
    path_list = session.get("path", [])
    if not path_list:
        handler._json(400, {"error": "no picks yet — pick a starting point first"})
        return
    parent_id = path_list[-1]
    nodes = session.get("nodes", {})
    parent_node = nodes.get(parent_id)
    if not parent_node:
        handler._json(404, {"error": f"parent node {parent_id!r} not found"})
        return
    deltas = _nudge_call(parent_node["params"], vocabulary, text)
    if deltas is None:
        handler._json(500, {"error": "Claude call failed for nudge"})
        return
    sys.path.insert(0, str(IDNA_DIR))
    try:
        from templates import get_template  # type: ignore[import-not-found]
        tmpl = get_template(session.get("template", "avatar"))
    except Exception as exc:
        handler._json(500, {"error": f"template load failed: {exc}"})
        return
    nudged_params = dict(parent_node["params"])
    axes = vocabulary.get("axes", [])
    for axis_name, delta in deltas.items():
        if isinstance(delta, (int, float)) and axis_name in nudged_params:
            nudged_params[axis_name] = round(max(0.0, min(1.0, nudged_params[axis_name] + delta)), 4)
    if hasattr(tmpl, "_compute_tags"):
        nudged_params["_tags"] = tmpl._compute_tags(nudged_params, axes)
    width = session.get("width", 3)
    children = _node_children_ids(parent_id, width)
    for child_id in list(children):
        if child_id in nodes:
            child_round = nodes[child_id]["round"]
            for fpath in [
                sdir / f"round_{child_round}" / f"{child_id}.png",
                sdir / f"round_{child_round}" / "embeds" / f"{child_id}.pt",
                sdir / f"round_{child_round}" / "prompts" / f"{child_id}.json",
            ]:
                fpath.unlink(missing_ok=True)
            del nodes[child_id]
    session["nodes"] = nodes
    session = _create_child_nodes(sdir, parent_id, session, override_params=nudged_params)
    session.setdefault("nudge_log", []).append({"parent_id": parent_id, "text": text, "deltas": deltas})
    write_session(project, subject, session)
    _ensure_worker(project, subject)
    handler._json(200, {"ok": True, "deltas": deltas, "children_regenerating": True})
