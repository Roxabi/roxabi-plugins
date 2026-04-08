"""Hi-res winner re-generation after finalize."""

from __future__ import annotations

import json

from .config import FINAL_WIDTH, FINAL_HEIGHT, log
from .daemon import _daemon_generate
from .nodes import _node_round
from .session import _session_dir, read_session, write_session


def _regen_winner_hires(project: str, subject: str, winner_id: str) -> None:
    """Re-generate the winner image at full resolution after finalize."""
    sdir = _session_dir(project, subject)
    session = read_session(project, subject)
    node = session.get("nodes", {}).get(winner_id)
    if not node:
        log.error("Winner node %s not found", winner_id)
        return

    round_num = node["round"]
    hires_dir = sdir / "final"
    prompts_dir = hires_dir / "prompts"
    prompts_dir.mkdir(parents=True, exist_ok=True)

    # Write hi-res job file (kept for reproducibility / audit trail)
    seed = node.get("seed", round_num * 100)
    job = {
        "id": winner_id,
        "label": node["label"],
        "seed": seed,
        "width": FINAL_WIDTH,
        "height": FINAL_HEIGHT,
        "prompt": node["prompt"],
    }
    (prompts_dir / f"{winner_id}.json").write_text(json.dumps(job, indent=2))

    # Re-use the low-res embed from the tree (same prompt, higher resolution output)
    tree_round = _node_round(winner_id)
    embed_path = sdir / f"round_{tree_round}" / "embeds" / f"{winner_id}.pt"
    if not embed_path.exists():
        log.error("Embed not found for winner %s at %s", winner_id, embed_path)
        session = read_session(project, subject)
        session["phase"] = "error"
        session["error"] = f"embed not found: {embed_path}"
        write_session(project, subject, session)
        return

    # Generate via daemon
    log.info("Re-generating winner %s at %dx%d via daemon...", winner_id, FINAL_WIDTH, FINAL_HEIGHT)
    daemon_jobs = [{
        "id": winner_id,
        "embed_path": str(embed_path),
        "out_path": str(hires_dir / f"{winner_id}.png"),
        "seed": seed,
        "width": FINAL_WIDTH,
        "height": FINAL_HEIGHT,
        "steps": 40,
    }]
    result = _daemon_generate(daemon_jobs)
    if not result.get("ok"):
        log.error("Hi-res re-gen failed: %s", result.get("error"))
        session = read_session(project, subject)
        session["phase"] = "error"
        session["error"] = f"hi-res re-gen failed: {result.get('error')}"
        write_session(project, subject, session)
        return

    hires_path = f"final/{winner_id}.png"
    session = read_session(project, subject)
    session["winner_hires"] = hires_path
    session["phase"] = "done"
    write_session(project, subject, session)
    log.info("Winner hi-res ready: %s", hires_path)
