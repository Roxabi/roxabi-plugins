"""POST /api/new handler — SSE session creation pipeline."""

from __future__ import annotations

import json
import random
import subprocess
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from .config import IDNA_DIR
from .daemon import _daemon_encode, _daemon_ensure_running, _daemon_generate
from .generation import _ensure_worker
from .nodes import _blend_pole_embeds, _build_daemon_jobs, _build_encode_jobs
from .session import _session_dir, read_session, write_session

if TYPE_CHECKING:
    from .server import IDNAHandler

Emitter = Callable[[dict], None]


def handle_new(handler: "IDNAHandler") -> None:
    """POST /api/new — create session, stream SSE setup progress."""
    length = int(handler.headers.get("Content-Length", 0))
    body = json.loads(handler.rfile.read(length)) if length else {}
    project  = (body.get("project") or "").strip().lower().replace(" ", "-")
    subject  = (body.get("subject") or "").strip().lower().replace(" ", "-")
    intent   = (body.get("intent") or "").strip()
    depth    = int(body.get("depth", 3))
    width    = int(body.get("width", 4))
    ratio    = (body.get("ratio") or "3:4").strip()
    template    = (body.get("template") or "").strip() or None
    embed_blend = bool(body.get("embed_blend", False))
    random_mode = bool(body.get("random", False))

    if random_mode:
        if not template:
            handler._json(400, {"error": "template required for random mode"})
            return
        if not project or not subject:
            handler._json(400, {"error": "project and subject are required"})
            return
        embed_blend = True  # random always uses embed_blend
    elif not project or not subject or not intent:
        handler._json(400, {"error": "project, subject, and intent are required"})
        return

    sdir = _session_dir(project, subject)
    if (sdir / "session.json").exists():
        sess = json.loads((sdir / "session.json").read_text())
        if sess.get("vocabulary"):
            handler._json(409, {"error": f"session {project}/{subject} already exists",
                                 "url": f"/{project}/{subject}/"})
            return

    sdir.mkdir(parents=True, exist_ok=True)
    handler.send_response(200)
    handler.send_header("Content-Type", "text/event-stream")
    handler.send_header("Cache-Control", "no-cache")
    handler.send_header("X-Accel-Buffering", "no")
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()

    def emit(data: dict) -> None:
        line = "data: " + json.dumps(data) + "\n\n"
        handler.wfile.write(line.encode())
        handler.wfile.flush()

    if random_mode:
        emit({"step": "vocabulary", "status": "running", "message": "Generating random vocabulary\u2026"})
        try:
            vocab = _random_vocabulary(template or "", width, intent or "")
        except Exception as exc:
            emit({"step": "vocabulary", "status": "error", "message": str(exc)})
            return
        anchor = intent or vocab.get("anchor", "")
        sess_init = {
            "id": f"{project}-{subject}-001",
            "template": template,
            "anchor": anchor,
            "width": width,
            "ratio": ratio,
            "embed_blend": True,
            "vocabulary": vocab,
            "depth": depth,
        }
        (sdir / "session.json").write_text(json.dumps(sess_init, indent=2))
        emit({"step": "vocabulary", "status": "done",
              "message": f"Random vocabulary \u2014 {len(vocab['poles'])} poles, {len(vocab['axes'])} axes"})
    else:
        emit({"step": "vocabulary", "status": "running", "message": "Designing your selector with Claude\u2026"})
        (sdir / "session.json").write_text(json.dumps({"ratio": ratio}))
        setup_args = [
            sys.executable, str(IDNA_DIR / "idna_setup.py"),
            str(sdir), "--depth", str(depth), "--width", str(width), "--intent", intent,
        ]
        if template:
            setup_args.extend(["--template", template])
        result = subprocess.run(setup_args, capture_output=True, text=True, timeout=180)
        if result.returncode != 0:
            emit({"step": "vocabulary", "status": "error", "message": result.stderr.strip()})
            return
        try:
            sess = json.loads((sdir / "session.json").read_text())
            n_poles = len(sess.get("vocabulary", {}).get("poles", []))
            sess["ratio"] = ratio
            if embed_blend:
                sess["embed_blend"] = True
            (sdir / "session.json").write_text(json.dumps(sess, indent=2))
        except Exception:
            n_poles = 0
        emit({"step": "vocabulary", "status": "done", "message": f"Vocabulary ready \u2014 {n_poles} poles"})

    emit({"step": "tree", "status": "running", "message": "Building exploration tree\u2026"})
    result = subprocess.run(
        [sys.executable, str(IDNA_DIR / "idna_build_tree.py"), str(sdir), f"--depth={depth}"],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode != 0:
        emit({"step": "tree", "status": "error", "message": result.stderr.strip()})
        return
    try:
        sess = json.loads((sdir / "session.json").read_text())
        n_nodes = len(sess.get("nodes", {}))
    except Exception:
        n_nodes = 0
    emit({"step": "tree", "status": "done", "message": f"{n_nodes} nodes built"})

    sess = json.loads((sdir / "session.json").read_text())
    if sess.get("template", "") in ("avatar", "logo"):
        if sess.get("embed_blend"):
            ok = _encode_poles(emit, sdir, sess)
            if ok:
                ok = _blend_and_generate(emit, project, subject, sdir, sess)
        else:
            ok = _encode_and_generate(emit, project, subject, sdir, sess)
        if not ok:
            return

    _ensure_worker(project, subject)
    emit({"step": "ready", "status": "done", "url": f"/{project}/{subject}/", "message": "Ready!"})


def _encode_poles(emit: Emitter, sdir: Path, sess: dict) -> bool:
    """Encode pole prompts once → sdir/poles/{i}.pt. Returns False on error."""
    emit({"step": "encode", "status": "running", "message": "Encoding poles via daemon…"})
    if not _daemon_ensure_running():
        emit({"step": "encode", "status": "error", "message": "imageCLI daemon failed to start"})
        return False

    sys.path.insert(0, str(IDNA_DIR))
    try:
        from templates import get_template  # type: ignore[import-not-found]
        tmpl = get_template(sess.get("template", "avatar"))
    except Exception as exc:
        emit({"step": "encode", "status": "error", "message": f"template load failed: {exc}"})
        return False

    vocabulary = sess.get("vocabulary", {})
    anchor = sess.get("anchor", "")
    poles = vocabulary.get("poles", [])
    poles_dir = sdir / "poles"
    poles_dir.mkdir(exist_ok=True)

    jobs = []
    for i, pole in enumerate(poles):
        pt_path = poles_dir / f"{i}.pt"
        if not pt_path.exists():
            params = tmpl.build_params(pole, vocabulary)
            prompt = tmpl.build_prompt(params, anchor)
            jobs.append({"id": f"pole_{i}", "prompt": prompt, "embed_path": str(pt_path)})

    if not jobs:
        emit({"step": "encode", "status": "done", "message": f"{len(poles)} poles cached"})
        return True

    n_total = len(jobs)
    result = _daemon_encode(
        jobs,
        on_progress=lambda msg: emit({"step": "encode", "status": "running",
                                      "message": f"Pole {msg}"}),
    )
    if not result.get("ok"):
        emit({"step": "encode", "status": "error", "message": result.get("error", "encode failed")})
        return False

    emit({"step": "encode", "status": "done", "message": f"{n_total} poles encoded"})
    return True


def _blend_and_generate(
    emit: Emitter,
    project: str,
    subject: str,
    sdir: Path,
    sess: dict,
) -> bool:
    """Blend round-0 node embeddings from poles, then generate. Returns False on error."""
    emit({"step": "encode", "status": "running", "message": "Blending pole embeddings for round 0…"})
    round0_ids = [nid for nid, n in sess.get("nodes", {}).items() if n.get("round") == 0]
    for nid in round0_ids:
        if not _blend_pole_embeds(sdir, nid, sess):
            emit({"step": "encode", "status": "error", "message": f"blend failed for {nid}"})
            return False
    sess2 = read_session(project, subject)
    for nid in round0_ids:
        if nid in sess2.get("nodes", {}):
            sess2["nodes"][nid]["status"] = "encoded"
    write_session(project, subject, sess2)
    emit({"step": "encode", "status": "done", "message": f"{len(round0_ids)} embeddings blended"})

    emit({"step": "generate", "status": "running", "message": "Generating round 0 via daemon…"})
    if not _daemon_ensure_running():
        emit({"step": "generate", "status": "error", "message": "imageCLI daemon failed to start"})
        return False
    sess3 = read_session(project, subject)
    round0_ids2 = [f"v{i}" for i in range(sess3.get("width", 4))]
    gen_result = _daemon_generate(_build_daemon_jobs(sdir, round0_ids2, sess3, steps=15))
    if not gen_result.get("ok"):
        emit({"step": "generate", "status": "error", "message": gen_result.get("error", "daemon failed")})
        return False
    sess4 = read_session(project, subject)
    for nid in round0_ids2:
        if nid in sess4.get("nodes", {}):
            sess4["nodes"][nid]["status"] = "ready"
    write_session(project, subject, sess4)
    emit({"step": "generate", "status": "done", "message": "Round 0 ready"})
    return True


def _encode_and_generate(
    emit: Emitter,
    project: str,
    subject: str,
    sdir: Path,
    sess: dict,
) -> bool:
    """Encode round-0 prompts and generate round-0 images. Returns False on error."""
    emit({"step": "encode", "status": "running", "message": "Encoding all prompts via daemon\u2026"})
    if not _daemon_ensure_running():
        emit({"step": "encode", "status": "error", "message": "imageCLI daemon failed to start"})
        return False
    round0_ids = [nid for nid, n in sess.get("nodes", {}).items() if n.get("round") == 0]
    enc_jobs = _build_encode_jobs(sdir, round0_ids, sess)
    enc_result = _daemon_encode(
        enc_jobs, timeout=600,
        on_progress=lambda msg: emit({"step": "encode", "status": "running", "message": msg}),
    )
    if not enc_result.get("ok"):
        emit({"step": "encode", "status": "error", "message": enc_result.get("error", "encode failed")})
        return False
    sess2 = read_session(project, subject)
    for nid in enc_result.get("encoded", []):
        if nid in sess2.get("nodes", {}):
            sess2["nodes"][nid]["status"] = "encoded"
    write_session(project, subject, sess2)
    emit({"step": "encode", "status": "done",
          "message": f"{len(enc_result.get('encoded', []))} prompts encoded"})

    emit({"step": "generate", "status": "running", "message": "Generating round 0 via daemon\u2026"})
    if not _daemon_ensure_running():
        emit({"step": "generate", "status": "error", "message": "imageCLI daemon failed to start"})
        return False
    sess3 = read_session(project, subject)
    round0_ids2 = [f"v{i}" for i in range(sess3.get("width", 4))]
    gen_result = _daemon_generate(_build_daemon_jobs(sdir, round0_ids2, sess3, steps=15))
    if not gen_result.get("ok"):
        emit({"step": "generate", "status": "error", "message": gen_result.get("error", "daemon failed")})
        return False
    sess4 = read_session(project, subject)
    for nid in round0_ids2:
        if nid in sess4.get("nodes", {}):
            sess4["nodes"][nid]["status"] = "ready"
    write_session(project, subject, sess4)
    emit({"step": "generate", "status": "done", "message": "Round 0 ready"})
    return True


def _random_vocabulary(template_name: str, width: int, anchor: str) -> dict:
    """Generate random vocabulary for a template — no LLM, pure math.

    Each pole is randomly placed at extremes of the axis space (0.05–0.20 or
    0.80–0.95) to guarantee distinct prompts. Maximises initial diversity.
    """
    sys.path.insert(0, str(IDNA_DIR))
    from templates import get_template  # type: ignore[import-not-found]
    tmpl = get_template(template_name)

    axes: list[dict] = getattr(tmpl, "DEFAULT_AXES", [])
    axis_priority: list[str] = getattr(tmpl, "DEFAULT_AXIS_PRIORITY",
                                       [a["name"] for a in axes])
    default_anchor: str = getattr(tmpl, "DEFAULT_ANCHOR", template_name)
    anchor = f"{anchor}, {default_anchor}" if anchor else default_anchor

    if not axes:
        raise ValueError(
            f"Template '{template_name}' has no DEFAULT_AXES — cannot generate random vocabulary"
        )

    rng = random.Random()
    poles: list[dict] = []
    for i in range(width):
        pole: dict = {"name": f"Pole {i + 1}"}
        for ax in axes:
            pole[ax["name"]] = round(
                rng.uniform(0.05, 0.20) if rng.random() < 0.5 else rng.uniform(0.80, 0.95), 2
            )
        poles.append(pole)

    return {
        "axes": axes,
        "axis_priority": axis_priority,
        "poles": poles,
        "mutation_vocab": {},
        "anchor": anchor,
    }
