#!/usr/bin/env bash
# Plugin-owned falsify oracle (#417 / ADR-019).
# Markdown is a report — this script is the gate.
#
# Usage:
#   run-falsify.sh --map <map.json> [--out <falsify.json>] [--issue N]
#   run-falsify.sh --verify <falsify.json>
#
# Map: { "issue": N, "rows": [ { "sc_id", "sources": [], "test_cmd" } ] }
#   test_cmd MUST be `.dev/stack.yml` commands.test + plain relative test paths;
#   it is re-derived and run as argv (no shell). Anything else refuses every row
#   (oracle_reason=refused-test-cmd:row<i>) — ADR-019 §2c, #541.
# Emits: oracle_ok=true|false  +  oracle_reason=<token>
# Always exit 0. Isolation = copy at HEAD with the working tree overlaid on top
# (¬git stash API) — see snapshot_repo, and ADR-019 §2a for what that makes
# oracle_ok attest.
set -euo pipefail

# A git hook exports GIT_DIR / GIT_INDEX_FILE, and they beat cwd: without this the head
# check, the archive and every test the snapshot runs would bind to that repository
# instead of the checkout the runner was invoked in (same list as check-principal-branch.sh).
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_INDEX_FILE \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CEILING_DIRECTORIES

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
import hashlib, json, os, re, shlex, shutil, subprocess, sys, tempfile
from pathlib import Path

mode = os.environ["MODE"]
runner_id = os.environ["RUNNER_ID"]

def emit(ok: bool, reason: str) -> None:
    print(f"oracle_ok={'true' if ok else 'false'}")
    print(f"oracle_reason={reason}")

def sha_file(p: Path) -> str:
    # Regular files only: a committed `z -> /dev/zero` must not be read before any guard.
    if p.is_symlink() or not p.is_file():
        return "missing"
    try:
        return hashlib.sha256(p.read_bytes()).hexdigest()
    except OSError:
        return "missing"

# A row names test paths; it never names what runs. The command is re-derived from
# the project contract (`.dev/stack.yml` commands.test_file, else commands.test) and
# executed as argv, without a shell: the artifact is committed by the PR author, who is
# the untrusted party at review time (#541). ADR-019 §2c prices what this does not close.
PLAIN_PATH = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_./@+-]*")
PLAIN_TOKEN = re.compile(r"[A-Za-z0-9_./@%+=:,-]+")
CONTRACT_KEYS = ("test_file", "test")

def plain_path(p) -> bool:
    # Test paths reach argv, so they are an allowlist.
    return isinstance(p, str) and PLAIN_PATH.fullmatch(p) is not None and ".." not in p.split("/")

def plain_source(s) -> bool:
    # Sources never reach argv — they are only hashed and deleted inside the snapshot —
    # so the only constraint is that they stay relative and cannot walk out of it.
    return (
        isinstance(s, str) and s != "" and "\0" not in s and not s.startswith("/")
        and all(seg not in ("", ".", "..") for seg in s.split("/"))
    )

def in_tree(root: Path, rel: str) -> bool:
    p = root / rel
    try:
        return p.resolve().is_relative_to(root.resolve()) and p.is_file()
    except (OSError, RuntimeError):
        return False

def quote_open(raw: str) -> bool:
    # True when a quoted scalar starts here and does not close on this line — YAML would
    # carry it onto the next lines, which this line reader does not follow.
    if raw[:1] not in ("'", '"'):
        return False
    return raw.find(raw[0], 1) == -1

def contract_test_argv() -> tuple[list[str] | None, str]:
    # A deliberately small subset of YAML, read line by line: only direct children of the
    # one top-level `commands:` count (a nested `e2e: {test: …}` is not commands.test), a
    # key's value is one line, and anything this reader cannot read the way YAML would —
    # a duplicate key, a multi-line value, non-ASCII, tabs — is refused, never guessed.
    # `test_file` (runs exactly the named files) wins over `test` when present.
    try:
        text = Path(".dev/stack.yml").read_text(encoding="utf-8")
    except OSError:
        return None, "missing-test-command"
    except UnicodeDecodeError:
        return None, "unsupported-test-command"
    lines = [line.rstrip("\r") for line in text.split("\n")]
    heads = [i for i, line in enumerate(lines) if re.fullmatch(r"commands:\s*(#.*)?", line)]
    if not heads:
        return None, "missing-test-command"
    if len(heads) > 1:
        return None, "unsupported-test-command"
    child, values, owner = None, {k: [] for k in CONTRACT_KEYS}, None
    for line in lines[heads[0] + 1:]:
        if not line.strip() or line.lstrip(" \t").startswith("#"):
            continue
        if line[0] not in " \t":
            break
        if line.startswith("\t") or not line.isascii():
            return None, "unsupported-test-command"
        body = line.lstrip(" ")
        indent = len(line) - len(body)
        child = indent if child is None else child
        if indent < child:
            return None, "unsupported-test-command"
        if indent > child:
            if owner is not None:  # a continuation of a contract key's value
                return None, "unsupported-test-command"
            continue
        m = re.fullmatch(r"([A-Za-z0-9_-]+):(?:[ \t]+(.*))?", body)
        raw = ((m.group(2) or "") if m else "").strip()
        if quote_open(raw):
            return None, "unsupported-test-command"
        owner = m.group(1) if m and m.group(1) in values else None
        if owner is not None:
            values[owner].append(raw)
    for key in CONTRACT_KEYS:
        if len(values[key]) > 1:
            return None, "unsupported-test-command"
        if values[key]:
            return scalar_argv(values[key][0])
    return None, "missing-test-command"

def scalar_argv(raw: str) -> tuple[list[str] | None, str]:
    # One YAML scalar → argv. Every token must be a plain word, and argv[0] must not be a
    # `VAR=value` prefix: the command runs without a shell, so anything whose meaning
    # needs one (operators, globs, `~`, env prefixes, escapes) is refused, never guessed.
    if not raw or raw.startswith("#"):
        return None, "missing-test-command"
    if raw[0] in ("'", '"'):
        end = raw.find(raw[0], 1)
        rest = raw[end + 1:].strip()
        if (rest and not rest.startswith("#")) or (raw[0] == '"' and "\\" in raw[1:end]):
            return None, "unsupported-test-command"
        value = raw[1:end]
    elif raw[0] in "|>{[&*!%@`":
        return None, "unsupported-test-command"
    else:
        value = re.split(r"[ \t]#", raw, maxsplit=1)[0]
    argv = value.split()
    if not argv:
        return None, "missing-test-command"
    if "=" in argv[0] or not all(PLAIN_TOKEN.fullmatch(t) for t in argv):
        return None, "unsupported-test-command"
    return argv, ""

def derive_argv(test_cmd, base: list[str]) -> tuple[list[str] | None, str]:
    if not isinstance(test_cmd, str):
        return None, "test_cmd is not a string"
    try:
        tokens = shlex.split(test_cmd)
    except ValueError as e:
        return None, f"unparseable ({e})"
    if tokens[:len(base)] != base:
        return None, "does not start with the contract's test command"
    paths = tokens[len(base):]
    if not paths:
        return None, "names no test path"
    bad = next((p for p in paths if not plain_path(p)), None)
    if bad is not None:
        return None, f"{bad!r} is not a plain relative path"
    return base + paths, ""

def run_cmd(cwd: Path, argv: list[str]) -> tuple[int, str]:
    try:
        r = subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True)
    except OSError as e:
        return 127, str(e)[:240]
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
    # HEAD tree — argv pipe, no shell anywhere in the runner
    archive = subprocess.Popen(["git", "archive", "HEAD"], stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", str(dest)], stdin=archive.stdout, check=True)
    archive.stdout.close()
    if archive.wait() != 0:
        raise subprocess.CalledProcessError(archive.returncode, ["git", "archive", "HEAD"])
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
        if not (src.is_symlink() or src.is_file()):
            continue
        target = dest / rel
        if target.is_symlink() or target.is_file():
            target.unlink()  # never write through a link the archive extracted
        target.parent.mkdir(parents=True, exist_ok=True)
        if src.is_symlink():
            os.symlink(os.readlink(src), target)  # a link stays a link; guards see it
        else:
            shutil.copy2(src, target)
    link_dependencies(dest)

def link_dependencies(dest: Path) -> None:
    # Installed dependencies are gitignored, so the overlay above never carries them,
    # and a re-derived `{commands.test}` (`bun run test` → vitest) would exit 127 in the
    # snapshot. Link each *entry* of a package's node_modules into a real dir of the
    # snapshot. Only dirs next to a package.json the overlay carries — never a blanket
    # "every ignored path" (`.env` stays out), and never `.venv`: an installer such as
    # `uv run` re-syncs *through* a linked venv and rewrites the real one.
    repo = Path.cwd().resolve()

    def link_entry(entry: Path, link: Path) -> None:
        # A workspace / `file:` link resolves into the repo: point it at the snapshot's
        # copy (relatively, so it survives the per-row copy), or a deleted source would
        # still be found in the real tree and the row would read as a tautology.
        try:
            real = entry.resolve()
        except (OSError, RuntimeError):
            return
        if entry.is_symlink() and real.is_relative_to(repo):
            os.symlink(os.path.relpath(dest / real.relative_to(repo), link.parent), link)
        else:
            os.symlink(entry.absolute(), link)

    r = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard", "-z", "--", "package.json", "*/package.json"],
        capture_output=True,
    )
    pkg_dirs = {Path(raw.decode("utf-8", "surrogateescape")).parent for raw in r.stdout.split(b"\0") if raw}
    for dep in [d / "node_modules" for d in sorted(pkg_dirs)]:
        if dep.is_symlink() or not dep.is_dir():
            continue
        target = dest / dep
        target.mkdir(parents=True, exist_ok=True)
        for entry in dep.iterdir():
            link = target / entry.name
            if link.exists() or link.is_symlink():
                continue
            if entry.name.startswith("@") and entry.is_dir() and not entry.is_symlink():
                link.mkdir()  # a scope dir: its children are the package links
                for pkg in entry.iterdir():
                    link_entry(pkg, link / pkg.name)
            else:
                link_entry(entry, link)

def remove_sources(root: Path, sources: list[str]) -> str:
    # The snapshot keeps symlinks (committed ones, and the dependency links above), so a
    # lexically plain source can still resolve outside it: refuse instead of deleting.
    for s in sources:
        p = root / s
        try:
            inside = p.resolve().is_relative_to(root.resolve())
        except (OSError, RuntimeError):
            inside = False
        if not inside:
            return f"source {s!r} resolves outside the snapshot"
        if p.is_symlink() or p.is_file():
            p.unlink()  # a link is removed, never followed
        elif p.is_dir():
            shutil.rmtree(p)
    return ""

def execute_map(map_path: Path, out_path: Path | None, issue_override) -> tuple[bool, str]:
    data = json.loads(map_path.read_text(encoding="utf-8"))
    issue = issue_override if issue_override is not None else data.get("issue", 0)
    rows_in = data.get("rows") or []
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()

    def fail(reason: str) -> tuple[bool, str]:
        if out_path:
            write_artifacts(out_path, issue, head, False, reason, [])
        return False, reason

    refused = []

    def refuse(i: int, row, why: str) -> None:
        refused.append(i)
        sc_id = row.get("sc_id") if isinstance(row, dict) else None
        print(f"run-falsify: refused row {i} (sc_id={sc_id!r}): {why}", file=sys.stderr)

    if not rows_in:
        return fail("empty-map")

    base, base_reason = contract_test_argv()
    if base is None:
        print(
            f"run-falsify: {base_reason}: .dev/stack.yml commands.test_file (else commands.test) must be "
            "one single-line plain command (plain words, no shell syntax, no VAR= prefix)",
            file=sys.stderr,
        )
        return fail(base_reason)
    shape = f"test_cmd must be {shlex.join(base)!r} followed by test file paths"

    # Validate every row before anything runs: one refused row executes nothing.
    argvs = []
    for i, row in enumerate(rows_in):
        if not isinstance(row, dict) or not isinstance(row.get("sources") or [], list):
            argv, why = None, "row must be an object with a sources list"
        else:
            argv, why = derive_argv(row.get("test_cmd"), base)
            why = f"{why}; {shape}" if argv is None else why
        if argv is not None and not all(plain_source(s) for s in row.get("sources") or []):
            argv, why = None, "sources must be relative paths with no '', '.' or '..' segment"
        if argv is None:
            refuse(i, row, why)
        argvs.append(argv)
    if refused:
        return fail(f"refused-test-cmd:row{refused[0]}")

    wt = Path(tempfile.mkdtemp(prefix="rf-wt."))
    try:
        snapshot_repo(wt)
        # A test path must be a file the snapshot carries. That is all it guarantees: the
        # runner still reads the token as it likes (a make target, a pytest module) —
        # ADR-019 §2c names that residual.
        for i, (row, argv) in enumerate(zip(rows_in, argvs)):
            stray = next((p for p in argv[len(base):] if not in_tree(wt, p)), None)
            if stray is not None:
                refuse(i, row, f"{stray!r} is not a file in the snapshot; {shape}")
        if refused:
            return fail(f"refused-test-cmd:row{refused[0]}")
        rows_out = []
        any_proven = False
        reason = "ok"

        for row, argv in zip(rows_in, argvs):
            sc = row.get("sc_id", "")
            sources = list(row.get("sources") or [])
            test_cmd = shlex.join(argv)
            hashes = {s: sha_file(Path(s)) for s in sources}

            fail_dir = Path(tempfile.mkdtemp(prefix="rf-fail."))
            try:
                # copy wt → fail_dir (links stay links) then delete sources
                shutil.copytree(wt, fail_dir, symlinks=True, dirs_exist_ok=True)
                escape = remove_sources(fail_dir, sources)
                if escape:
                    rows_out.append({
                        "sc_id": sc, "sources": sources, "source_hashes": hashes,
                        "test_cmd": test_cmd, "fail_exit": None, "pass_exit": None,
                        "error": escape, "status": "failed",
                    })
                    reason = "source-escape"
                    continue

                fail_ec, fail_out = run_cmd(fail_dir, argv)
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

                pass_ec, _pass_out = run_cmd(wt, argv)
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
    if not isinstance(doc, dict) or doc.get("schema_version") != "1":
        return False, "bad-schema"

    head_now = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if doc.get("head") != head_now:
        return False, "head-mismatch"

    rows = doc.get("rows") or []
    if not isinstance(rows, list):
        return False, "bad-schema"
    if not rows:
        return False, "empty-map"

    # Full re-exec from documented rows — passed through untouched, so execute_map's row
    # guard refuses a malformed one exactly as it does on --map.
    tmp_map = Path(tempfile.mkstemp(suffix=".json")[1])
    tmp_out = Path(tempfile.mkstemp(suffix=".json")[1])
    try:
        tmp_map.write_text(json.dumps({"issue": doc.get("issue", 0), "rows": rows}), encoding="utf-8")
        return execute_map(tmp_map, tmp_out, doc.get("issue"))
    finally:
        tmp_map.unlink(missing_ok=True)
        tmp_out.unlink(missing_ok=True)
        tmp_out.with_suffix(".md").unlink(missing_ok=True)

def main() -> tuple[bool, str]:
    if mode == "run":
        map_path = Path(sys.argv[1])
        out_path = Path(sys.argv[2]) if sys.argv[2] != "" else None
        issue_override = sys.argv[3] if sys.argv[3] != "" else None
        if issue_override is not None and str(issue_override).isdigit():
            issue_override = int(issue_override)
        if not map_path.is_file():
            return False, "missing-map"
        return execute_map(map_path, out_path, issue_override)
    if mode == "verify":
        return verify(Path(sys.argv[1]))
    return False, "bad-args"

# "Always exit 0, always emit oracle_ok": the artifact is untrusted input, so whatever
# it makes this script raise must still end as a fail-closed verdict, never as silence.
try:
    ok, reason = main()
except Exception as e:  # noqa: BLE001 — the gate needs a verdict, not a traceback
    print(f"run-falsify: runner-error: {type(e).__name__}: {e}", file=sys.stderr)
    ok, reason = False, "runner-error"
emit(ok, reason)
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
