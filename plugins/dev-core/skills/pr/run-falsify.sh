#!/usr/bin/env bash
# Plugin-owned falsify oracle (#417 / ADR-019).
# Markdown is a report — this script is the gate.
#
# Usage:
#   run-falsify.sh --map <map.json> [--out <falsify.json>] [--issue N]
#   run-falsify.sh --verify <falsify.json>
#
# Map: { "issue": N, "rows": [ { "sc_id", "sources": [], "test_cmd" } ] }
# Emits: oracle_ok=true|false  +  oracle_reason=<token>
# Always exit 0. Isolation = temp copy at HEAD (¬git stash API).
set -euo pipefail

RUNNER_ID="run-falsify/1"

rf_emit() {
  echo "oracle_ok=${ORACLE_OK:-false}"
  echo "oracle_reason=${ORACLE_REASON:-missing}"
}

# Core logic in Python for JSON + subprocess reliability.
rf_python() {
  local mode="$1"
  shift
  ORACLE_OK=false
  ORACLE_REASON=missing
  local out
  out="$(MODE="$mode" RUNNER_ID="$RUNNER_ID" python3 - "$@" <<'PY'
import hashlib, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

mode = os.environ["MODE"]
runner_id = os.environ["RUNNER_ID"]

def emit(ok: bool, reason: str) -> None:
    print(f"oracle_ok={'true' if ok else 'false'}")
    print(f"oracle_reason={reason}")

def sha_file(p: Path) -> str:
    try:
        return hashlib.sha256(p.read_bytes()).hexdigest()
    except OSError:
        return "missing"

def run_cmd(cwd: Path, cmd: str) -> tuple[int, str]:
    r = subprocess.run(["bash", "-lc", cmd], cwd=str(cwd), capture_output=True, text=True)
    out = (r.stdout or "") + (r.stderr or "")
    return r.returncode, out.replace("\n", " ")[:240]

def write_artifacts(out: Path, issue, head: str, ok: bool, reason: str, rows: list) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "schema_version": "1",
        "issue": issue,
        "head": head,
        "runner_id": runner_id,
        "oracle_ok": ok,
        "oracle_reason": reason,
        "rows": rows,
    }
    out.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    md = out.with_suffix(".md")
    lines = [
        "## SC → Test Matrix", "",
        "| SC | Test(s) | Status |",
        "|----|---------|--------|",
    ]
    for r in rows:
        st = "✓ proven" if r.get("status") == "proven" else r.get("status", "failed")
        lines.append(f"| {r.get('sc_id', '?')}: | `{r.get('test_cmd', '')}` | {st} |")
    lines += ["", "## Falsification Evidence", ""]
    for r in rows:
        if r.get("status") == "proven" and r.get("error"):
            src = (r.get("sources") or ["?"])[0]
            lines.append(f"broke {src} → {r['error']}")
    md.write_text("\n".join(lines) + "\n", encoding="utf-8")

def snapshot_repo(dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    # HEAD tree
    subprocess.run(["bash", "-lc", f"git archive HEAD | tar -x -C {dest}"], check=True)
    # Overlay dirty + untracked (best-effort)
    r = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard", "-z"],
        capture_output=True,
    )
    for raw in r.stdout.split(b"\0"):
        if not raw:
            continue
        rel = raw.decode("utf-8", "surrogateescape")
        src = Path(rel)
        if not src.is_file():
            continue
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)

def execute_map(map_path: Path, out_path: Path | None, issue_override) -> tuple[bool, str]:
    data = json.loads(map_path.read_text(encoding="utf-8"))
    issue = issue_override if issue_override is not None else data.get("issue", 0)
    rows_in = data.get("rows") or []
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()

    if not rows_in:
        if out_path:
            write_artifacts(out_path, issue, head, False, "empty-map", [])
        return False, "empty-map"

    wt = Path(tempfile.mkdtemp(prefix="rf-wt."))
    try:
        snapshot_repo(wt)
        rows_out = []
        any_proven = False
        reason = "ok"

        for row in rows_in:
            sc = row.get("sc_id", "")
            sources = list(row.get("sources") or [])
            test_cmd = row.get("test_cmd") or ""
            hashes = {s: sha_file(Path(s)) for s in sources}

            fail_dir = Path(tempfile.mkdtemp(prefix="rf-fail."))
            try:
                # copy wt → fail_dir then delete sources
                shutil.copytree(wt, fail_dir, dirs_exist_ok=True)
                for s in sources:
                    p = fail_dir / s
                    if p.exists():
                        p.unlink()

                fail_ec, fail_out = run_cmd(fail_dir, test_cmd)
                if fail_ec == 0:
                    rows_out.append({
                        "sc_id": sc, "sources": sources, "source_hashes": hashes,
                        "test_cmd": test_cmd, "fail_exit": 0, "pass_exit": 1,
                        "error": "TAUTOLOGICAL: passed with sources absent",
                        "status": "failed",
                    })
                    reason = "tautology"
                    continue

                err = fail_out
                if not any(t in err for t in ("AssertionError", "FAIL ", "toThrow", "Error:")):
                    err = f"FAIL exit={fail_ec}: {err}"

                pass_ec, _pass_out = run_cmd(wt, test_cmd)
                if pass_ec == 0:
                    any_proven = True
                    rows_out.append({
                        "sc_id": sc, "sources": sources, "source_hashes": hashes,
                        "test_cmd": test_cmd, "fail_exit": fail_ec, "pass_exit": 0,
                        "error": err, "status": "proven",
                    })
                else:
                    reason = "restore-failed"
                    rows_out.append({
                        "sc_id": sc, "sources": sources, "source_hashes": hashes,
                        "test_cmd": test_cmd, "fail_exit": fail_ec, "pass_exit": pass_ec,
                        "error": f"restore-failed exit={pass_ec}", "status": "failed",
                    })
            finally:
                shutil.rmtree(fail_dir, ignore_errors=True)

        ok = any_proven and all(r.get("status") == "proven" for r in rows_out)
        if not ok and reason == "ok":
            reason = "no-proven-row" if not any_proven else "row-failed"

        if out_path is None:
            out_path = Path(f"artifacts/reviews/{issue}-falsify.json")
        write_artifacts(out_path, issue, head, ok, reason, rows_out)
        return ok, reason
    finally:
        shutil.rmtree(wt, ignore_errors=True)

def verify(json_path: Path) -> tuple[bool, str]:
    if not json_path.is_file():
        return False, "missing-artifact"
    try:
        doc = json.loads(json_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False, "bad-schema"
    if doc.get("schema_version") != "1":
        return False, "bad-schema"

    head_now = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if doc.get("head") != head_now:
        return False, "head-mismatch"

    rows = doc.get("rows") or []
    if not rows:
        return False, "empty-map"

    # Full re-exec from documented rows
    tmp_map = Path(tempfile.mkstemp(suffix=".json")[1])
    tmp_out = Path(tempfile.mkstemp(suffix=".json")[1])
    try:
        m = {
            "issue": doc.get("issue", 0),
            "rows": [
                {"sc_id": r.get("sc_id"), "sources": r.get("sources") or [], "test_cmd": r.get("test_cmd", "")}
                for r in rows
            ],
        }
        tmp_map.write_text(json.dumps(m), encoding="utf-8")
        ok, reason = execute_map(tmp_map, tmp_out, doc.get("issue"))
        return ok, reason
    finally:
        tmp_map.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)

if mode == "run":
    map_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if sys.argv[2] != "" else None
    issue_override = sys.argv[3] if sys.argv[3] != "" else None
    if issue_override is not None and str(issue_override).isdigit():
        issue_override = int(issue_override)
    if not map_path.is_file():
        emit(False, "missing-map")
        raise SystemExit(0)
    ok, reason = execute_map(map_path, out_path, issue_override)
    emit(ok, reason)
elif mode == "verify":
    ok, reason = verify(Path(sys.argv[1]))
    emit(ok, reason)
else:
    emit(False, "bad-args")
PY
)"
  # Parse last oracle_ok/reason lines from python stdout
  ORACLE_OK="$(printf '%s\n' "$out" | sed -n 's/^oracle_ok=//p' | tail -1)"
  ORACLE_REASON="$(printf '%s\n' "$out" | sed -n 's/^oracle_reason=//p' | tail -1)"
  printf '%s\n' "$out"
}

MODE=""
MAP=""
OUT=""
ISSUE=""
VERIFY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --map) MODE=run; MAP="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --issue) ISSUE="${2:-}"; shift 2 ;;
    --verify) MODE=verify; VERIFY="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) ORACLE_OK=false; ORACLE_REASON=bad-args; rf_emit; exit 0 ;;
  esac
done

case "$MODE" in
  run) rf_python run "$MAP" "${OUT:-}" "${ISSUE:-}" ;;
  verify)
    if [ -z "$VERIFY" ]; then ORACLE_OK=false; ORACLE_REASON=missing-artifact; rf_emit; exit 0; fi
    rf_python verify "$VERIFY"
    ;;
  *) ORACLE_OK=false; ORACLE_REASON=bad-args; rf_emit ;;
esac
exit 0
