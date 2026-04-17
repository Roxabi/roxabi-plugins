"""Background generation worker for IDNA sessions."""

from __future__ import annotations

import sys
import threading

from .config import IDNA_DIR, log
from .daemon import _daemon_encode, _daemon_ensure_running, _daemon_generate
from .nodes import (
    _blend_pole_embeds,
    _build_daemon_jobs,
    _build_encode_jobs,
    _create_child_nodes,
    _ensure_job_file,
    _node_children_ids,
    _node_round,
)
from .session import _key, _session_dir, _is_new_format, read_session, write_session, _workers, _workers_lock


def _get_artifact_type(session: dict) -> str:
    """Get artifact_type from session template. Defaults to 'image' for legacy sessions."""
    template_name = session.get("template", "avatar")
    try:
        sys.path.insert(0, str(IDNA_DIR))
        from templates import get_template  # type: ignore[import-not-found]
        return get_template(template_name).artifact_type  # type: ignore[no-any-return]
    except Exception:
        return "image"


def _generation_worker(project: str, subject: str) -> None:
    """BFS generation worker: sends batches to the imageCLI daemon."""
    sdir = _session_dir(project, subject)

    log.info("Generation worker started: %s/%s", project, subject)

    session = read_session(project, subject)
    artifact_type = _get_artifact_type(session)

    # html/text nodes are already rendered by build_tree — nothing to do
    if artifact_type in ("html", "text"):
        log.info("Generation worker: artifact_type=%s, no generation needed", artifact_type)
        session["gen_status"] = "idle"
        write_session(project, subject, session)
        return

    # audio: TODO — voiceCLI integration not yet implemented
    if artifact_type == "audio":
        log.warning("Generation worker: audio artifact_type — voiceCLI integration TODO")
        session["gen_status"] = "idle"
        write_session(project, subject, session)
        return

    if not _daemon_ensure_running():
        log.error("imageCLI daemon failed to start — cannot generate images")
        session["gen_status"] = "error"
        write_session(project, subject, session)
        return

    while True:
        session = read_session(project, subject)
        if not _is_new_format(session):
            break

        nodes = session.get("nodes", {})
        path = session.get("path", [])
        actionable = {"pending", "encoded"}

        # Lazy generation: only generate children of the last picked node.
        # Round 0 is handled by the SSE /api/new handler directly.
        if not path:
            pending: list[str] = []
        else:
            parent = path[-1]
            width = session.get("width", 3)
            children = _node_children_ids(parent, width)
            # On-demand node creation: if children don't exist yet, create them now.
            if not any(c in nodes for c in children):
                log.info("Creating on-demand children for %s (round %d+1)", parent, _node_round(parent))
                session = _create_child_nodes(sdir, parent, session)
                write_session(project, subject, session)
                nodes = session.get("nodes", {})
            pending = [nid for nid in children if nodes.get(nid, {}).get("status") in actionable]

        if not pending:
            session["gen_status"] = "idle"
            write_session(project, subject, session)
            log.info("Generation worker idle: %s/%s (waiting for pick)", project, subject)
            break

        batch_round = _node_round(pending[0])
        batch = pending

        log.info("Generating batch: round %d, %d nodes (%s)", batch_round, len(batch), batch)

        # Ensure job files exist for all batch nodes
        for nid in batch:
            node = nodes.get(nid)
            if node and node.get("prompt"):
                _ensure_job_file(sdir, node, session)

        # Ensure embed/output dirs exist
        round_dir = sdir / f"round_{batch_round}"
        round_dir.mkdir(parents=True, exist_ok=True)
        (round_dir / "embeds").mkdir(exist_ok=True)

        # Encode any nodes that don't have embeddings yet
        needs_encode = [
            nid for nid in batch
            if not (round_dir / "embeds" / f"{nid}.pt").exists()
        ]
        if needs_encode:
            session["gen_status"] = "encoding"
            write_session(project, subject, session)
            if session.get("embed_blend"):
                log.info("Blending %d node embed(s) from poles...", len(needs_encode))
                for nid in needs_encode:
                    if not _blend_pole_embeds(sdir, nid, session):
                        log.error("Blend failed for %s", nid)
                        session = read_session(project, subject)
                        session["gen_status"] = "error"
                        write_session(project, subject, session)
                        break
                else:
                    session = read_session(project, subject)
                    for nid in needs_encode:
                        if nid in session.get("nodes", {}):
                            session["nodes"][nid]["status"] = "encoded"
                    write_session(project, subject, session)
                    continue  # skip to generate step
                break  # blend failed
            else:
                log.info("Encoding %d node(s) via daemon...", len(needs_encode))
                enc_jobs = _build_encode_jobs(sdir, needs_encode, session)
                enc_result = _daemon_encode(enc_jobs)
                if not enc_result.get("ok"):
                    log.error("Daemon encode failed: %s", enc_result.get("error"))
                    session = read_session(project, subject)
                    session["gen_status"] = "error"
                    write_session(project, subject, session)
                    break
                session = read_session(project, subject)
                for nid in needs_encode:
                    if nid in session.get("nodes", {}):
                        session["nodes"][nid]["status"] = "encoded"
                write_session(project, subject, session)

        session = read_session(project, subject)
        session["gen_status"] = "generating"
        write_session(project, subject, session)

        # Send batch to imageCLI daemon
        daemon_jobs = _build_daemon_jobs(sdir, batch, session, steps=15)
        result = _daemon_generate(daemon_jobs)

        # Re-read session in case queue was reordered by pick
        session = read_session(project, subject)
        nodes = session["nodes"]

        if not result.get("ok"):
            log.error("Daemon generation failed for round %d: %s", batch_round, result.get("error"))
            for nid in batch:
                if nid in nodes:
                    nodes[nid]["status"] = "error"
            session["nodes"] = nodes
            session["gen_status"] = "error"
            write_session(project, subject, session)
            log.error("Generation worker stopping after round %d failure", batch_round)
            break
        else:
            for nid in batch:
                if nid in nodes:
                    img_path = sdir / f"round_{batch_round}" / f"{nid}.png"
                    if img_path.exists():
                        nodes[nid]["status"] = "ready"
                    else:
                        nodes[nid]["status"] = "error"

        write_session(project, subject, session)

    log.info("Generation worker exited: %s/%s", project, subject)


def _ensure_worker(project: str, subject: str) -> None:
    """Start generation worker if not already running."""
    k = _key(project, subject)
    with _workers_lock:
        if k not in _workers or not _workers[k].is_alive():
            t = threading.Thread(target=_generation_worker, args=(project, subject), daemon=True)
            _workers[k] = t
            t.start()
