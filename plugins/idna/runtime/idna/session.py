"""Per-session state: locking, read/write, and discovery."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from .config import IDNA_DIR

_locks: dict[str, threading.Lock] = {}
_workers: dict[str, threading.Thread] = {}
_workers_lock = threading.Lock()


def _key(project: str, subject: str) -> str:
    return f"{project}/{subject}"


def _lock(project: str, subject: str) -> threading.Lock:
    k = _key(project, subject)
    if k not in _locks:
        _locks[k] = threading.Lock()
    return _locks[k]


def _session_dir(project: str, subject: str) -> Path:
    return IDNA_DIR / project / subject


def _session_file(project: str, subject: str) -> Path:
    return _session_dir(project, subject) / "session.json"


def read_session(project: str, subject: str) -> dict:
    with _lock(project, subject):
        return json.loads(_session_file(project, subject).read_text())  # type: ignore[no-any-return]


def write_session(project: str, subject: str, session: dict) -> None:
    with _lock(project, subject):
        _session_file(project, subject).write_text(json.dumps(session, indent=2))


def _is_new_format(session: dict) -> bool:
    return "nodes" in session


def discover_sessions() -> list[dict]:
    sessions: list[dict] = []
    for f in sorted(IDNA_DIR.glob("*/*/session.json")):
        try:
            data = json.loads(f.read_text())
            project = f.parent.parent.name
            subject = f.parent.name
            if _is_new_format(data):
                path = data.get("path", [])
                nodes = data.get("nodes", {})
                # Display image: winner hi-res > winner tree > last picked > nothing
                display_img = None
                if data.get("winner_hires"):
                    display_img = f"/{project}/{subject}/{data['winner_hires']}"
                elif data.get("winner"):
                    w = nodes.get(data["winner"], {})
                    if w.get("artifact"):
                        display_img = f"/{project}/{subject}/{w['artifact']}"
                elif path:
                    last = nodes.get(path[-1], {})
                    if last.get("status") == "ready" and last.get("artifact"):
                        display_img = f"/{project}/{subject}/{last['artifact']}"
                sessions.append({
                    "project": project,
                    "subject": subject,
                    "url": f"/{project}/{subject}/",
                    "gen_status": data.get("gen_status", "idle"),
                    "phase": data.get("phase", "picking"),
                    "round": len(path),
                    "display_img": display_img,
                    "ratio": data.get("ratio", "3:4"),
                    "template": data.get("template", ""),
                    "format": "new",
                })
            else:
                sessions.append({
                    "project": project,
                    "subject": subject,
                    "url": f"/{project}/{subject}/",
                    "gen_status": data.get("status", "unknown"),
                    "phase": data.get("phase", "explore"),
                    "round": data.get("round", 0),
                    "display_img": None,
                    "ratio": "3:4",
                    "template": "",
                    "format": "legacy",
                })
        except Exception:
            pass
    return sessions
