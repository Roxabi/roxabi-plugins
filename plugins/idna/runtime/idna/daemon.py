"""imageCLI daemon client — generate and encode via unix socket."""

from __future__ import annotations

import json
import socket
import subprocess
import time
from collections.abc import Callable

from .config import DAEMON_SOCK, log


def _daemon_generate(jobs: list[dict], timeout: int = 600) -> dict:
    """Send a generate request to the imageCLI daemon via unix socket.

    Each job: {"id", "embed_path", "out_path", "seed", "width", "height", "steps"}
    Returns {"ok": True, "generated": [...]} or {"ok": False, "error": "..."}.
    Progress lines are logged as they arrive.
    """
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(str(DAEMON_SOCK))
        payload = json.dumps({"action": "generate", "jobs": jobs}) + "\n"
        sock.sendall(payload.encode())

        buf = bytearray()
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf.extend(chunk)
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line:
                    continue
                obj = json.loads(line)
                if "ok" in obj:
                    return obj  # type: ignore[no-any-return]
                if "progress" in obj:
                    log.info("[daemon] %s", obj["progress"])
        return {"ok": False, "error": "daemon closed connection unexpectedly"}
    finally:
        sock.close()


def _daemon_encode(
    jobs: list[dict],
    timeout: int = 300,
    on_progress: Callable[[str], None] | None = None,
) -> dict:
    """Send an encode request to the imageCLI daemon via unix socket.

    Each job: {"id", "prompt", "embed_path"}
    Returns {"ok": True, "encoded": [...]} or {"ok": False, "error": "..."}.
    Progress lines are passed to on_progress(msg) if provided, otherwise logged.
    """
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(str(DAEMON_SOCK))
        payload = json.dumps({"action": "encode", "jobs": jobs}) + "\n"
        sock.sendall(payload.encode())

        buf = bytearray()
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf.extend(chunk)
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line:
                    continue
                obj = json.loads(line)
                if "ok" in obj:
                    return obj  # type: ignore[no-any-return]
                if "progress" in obj:
                    if on_progress:
                        on_progress(obj["progress"])
                    else:
                        log.info("[daemon encode] %s", obj["progress"])
        return {"ok": False, "error": "daemon closed connection unexpectedly"}
    finally:
        sock.close()


def _daemon_blend(inputs: list[dict], out_path: str, timeout: int = 30) -> dict:
    """Blend pre-encoded .pt embeddings in the daemon process (has torch).

    inputs: [{"path": str, "weight": float}, ...]
    Returns {"ok": True} or {"ok": False, "error": "..."}.
    """
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(str(DAEMON_SOCK))
        payload = json.dumps({"action": "blend", "inputs": inputs, "out_path": out_path}) + "\n"
        sock.sendall(payload.encode())
        buf = bytearray()
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf.extend(chunk)
            if b"\n" in buf:
                line, _ = buf.split(b"\n", 1)
                return json.loads(line)  # type: ignore[no-any-return]
        return {"ok": False, "error": "daemon closed connection unexpectedly"}
    finally:
        sock.close()


def _daemon_ping() -> bool:
    """Check if the imageCLI daemon is alive."""
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(str(DAEMON_SOCK))
        sock.sendall((json.dumps({"action": "ping"}) + "\n").encode())
        data = sock.recv(4096)
        sock.close()
        return json.loads(data.split(b"\n")[0]).get("ok", False)  # type: ignore[no-any-return]
    except Exception:
        return False


def _daemon_ensure_running(timeout: int = 60) -> bool:
    """Ensure the imageCLI daemon is running, starting it via supervisorctl if needed.

    Returns True if daemon is ready, False if it failed to start within timeout.
    """
    if _daemon_ping():
        return True

    log.info("imageCLI daemon not running — starting imagecli_gen via supervisorctl...")
    try:
        subprocess.run(
            ["supervisorctl", "start", "imagecli_gen"],
            capture_output=True, timeout=10,
        )
    except Exception as exc:
        log.error("supervisorctl start imagecli_gen failed: %s", exc)
        return False

    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(2)
        if _daemon_ping():
            log.info("imageCLI daemon ready.")
            return True

    log.error("imageCLI daemon did not become ready within %ds", timeout)
    return False
