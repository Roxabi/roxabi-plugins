"""HTTP server, routing, and main entry point for IDNA."""

from __future__ import annotations

import json
import re
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

from .api import handle_back, handle_delete, handle_finalize, handle_nudge, handle_pick, handle_reset, handle_reroll
from .api_new import handle_new
from .config import IDNA_DIR, MIME, log
from .daemon import _daemon_ping
from .generation import _ensure_worker, _get_artifact_type
from .html_index import _index_html
from .html_picker import PICKER_HTML
from .nodes import _node_children_ids
from .session import _is_new_format, _session_dir, discover_sessions, read_session


_SAFE_SEGMENT = re.compile(r"[a-z0-9][a-z0-9\-]{0,63}$")


def _parse_path(path: str) -> tuple[str | None, str | None, str]:
    """Return (project, subject, rest) or (None, None, path) for index."""
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return None, None, path
    project, subject = parts[0], parts[1]
    if not _SAFE_SEGMENT.match(project) or not _SAFE_SEGMENT.match(subject):
        return None, None, path
    rest = "/" + "/".join(parts[2:]) if len(parts) > 2 else "/"
    if path.endswith("/") and not rest.endswith("/"):
        rest += "/"
    return project, subject, rest


_ALLOWED_ORIGINS = {"http://localhost", "http://127.0.0.1"}


class IDNAHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: object) -> None:  # noqa: A002
        pass  # suppress default access log

    def _cors_origin(self) -> str:
        origin = self.headers.get("Origin", "")
        # Match http://localhost:<port> or http://127.0.0.1:<port>
        base = origin.rsplit(":", 1)[0] if origin.count(":") >= 2 else origin
        return origin if base in _ALLOWED_ORIGINS else ""

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        cors = self._cors_origin()
        if cors:
            self.send_header("Access-Control-Allow-Origin", cors)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, data: object) -> None:
        self._send(code, json.dumps(data).encode(), "application/json")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        cors = self._cors_origin()
        if cors:
            self.send_header("Access-Control-Allow-Origin", cors)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?")[0]
        project, subject, rest = _parse_path(path)

        if project is None or subject is None:
            body = _index_html(discover_sessions(), daemon_ok=_daemon_ping()).encode()
            self._send(200, body, "text/html; charset=utf-8")
            return

        _project: str = project
        _subject: str = subject
        sdir = _session_dir(_project, _subject)

        if rest in ("/", ""):
            self._send(200, PICKER_HTML.encode(), "text/html; charset=utf-8")
            return

        if rest == "/api/status":
            session = read_session(_project, _subject)
            if not _is_new_format(session):
                self._json(200, {"error": "legacy format", "gen_status": "legacy",
                                  "phase": "legacy", "path": [], "nodes": {}, "queue_length": 0})
                return
            artifact_type = _get_artifact_type(session)
            self._json(200, {
                "id": session.get("id"),
                "template": session.get("template", "avatar"),
                "artifact_type": artifact_type,
                "phase": session.get("phase", "picking"),
                "gen_status": session.get("gen_status", "idle"),
                "path": session.get("path", []),
                "winner": session.get("winner"),
                "queue_length": len(session.get("queue", [])),
                "nodes": session.get("nodes", {}),
                "ratio": session.get("ratio", "3:4"),
                "daemon_available": _daemon_ping() if artifact_type == "image" else None,
            })
            return

        if rest == "/api/tree":
            session = read_session(_project, _subject)
            if not _is_new_format(session):
                self._json(200, {})
                return
            self._json(200, session.get("nodes", {}))
            return

        # Static files (images, etc.)
        file_path = sdir / rest.lstrip("/")
        if not file_path.resolve().is_relative_to(sdir.resolve()):
            self._json(403, {"error": "forbidden"})
            return
        if file_path.exists() and file_path.is_file():
            mime = MIME.get(file_path.suffix.lower(), "application/octet-stream")
            self._send(200, file_path.read_bytes(), mime)
        else:
            self._json(404, {"error": f"not found: {rest}"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0]

        if path == "/api/new":
            handle_new(self)
            return

        project, subject, rest = _parse_path(path)
        if project is None or subject is None:
            self._json(404, {"error": "not found"})
            return

        _project: str = project
        _subject: str = subject
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        routes: dict[str, object] = {
            "/api/pick":     lambda: handle_pick(self, _project, _subject, body),
            "/api/back":     lambda: handle_back(self, _project, _subject),
            "/api/reroll":   lambda: handle_reroll(self, _project, _subject),
            "/api/finalize": lambda: handle_finalize(self, _project, _subject),
            "/api/nudge":    lambda: handle_nudge(self, _project, _subject, body),
            "/api/reset":    lambda: handle_reset(self, _project, _subject),
            "/api/delete":   lambda: handle_delete(self, _project, _subject),
        }
        handler_fn = routes.get(rest)
        if handler_fn:
            handler_fn()  # type: ignore[operator]
        else:
            self._json(404, {"error": "not found"})


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8082
    server = HTTPServer(("localhost", port), IDNAHandler)
    log.info("IDNA server on http://localhost:%d/", port)
    log.info("Sessions root: %s", IDNA_DIR)
    sessions = discover_sessions()
    for s in sessions:
        gen_s = s.get("gen_status", s.get("status", "?"))
        log.info("  %s/%s [%s]", s["project"], s["subject"], gen_s)
        project, subject = s["project"], s["subject"]
        if gen_s == "generating":
            log.info("  Resuming generation worker for %s/%s", project, subject)
            _ensure_worker(project, subject)
            continue
        try:
            sess = json.loads((_session_dir(project, subject) / "session.json").read_text())
            path = sess.get("path", [])
            nodes = sess.get("nodes", {})
            if path and _is_new_format(sess) and sess.get("phase") == "picking" and not sess.get("winner"):
                children = _node_children_ids(path[-1], sess.get("width", 3))
                if not all(nodes.get(c, {}).get("status") == "ready" for c in children):
                    log.info("  Resuming generation worker for %s/%s", project, subject)
                    _ensure_worker(project, subject)
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("Stopped.")
