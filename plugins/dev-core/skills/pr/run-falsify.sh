#!/usr/bin/env bash
# Plugin-owned falsify oracle (#417 / ADR-019).
# Markdown is a report — this script is the gate.
#
# Usage:
#   run-falsify.sh --map <map.json> [--out <falsify.json>] [--issue N]
#   run-falsify.sh --verify <falsify.json>
#
# Map: { "issue": N, "rows": [ { "sc_id", "sources": [], "test_cmd" } ] }
#   test_cmd MUST be the contract's command (`.dev/stack.yml` commands.test_file, else
#   commands.test — read with Bun.YAML) + plain relative test paths; run as argv, no
#   shell. Anything else refuses every row (refused-test-cmd:row<i>) — ADR-019 §2c.
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
  out="$(MODE="$mode" RUNNER_ID="$RUNNER_ID" python3 -I - "$@" <<'PY'
import hashlib, json, os, re, shlex, shutil, stat, subprocess, sys, tempfile
from pathlib import Path

mode = os.environ["MODE"]
runner_id = os.environ["RUNNER_ID"]

def emit(ok: bool, reason: str) -> None:
    print(f"oracle_ok={'true' if ok else 'false'}")
    print(f"oracle_reason={reason}")

# ── Containment ──────────────────────────────────────────────────────────────────
# Every path below comes from the PR (the artifact, the tree, the contract). Each one is
# read, hashed, written or deleted through these functions and nowhere else: a path must
# resolve inside its root, and a read opens a regular file without following a final
# link (#541 — ADR-019 §2c).
CONTRACT_CAP = 64 * 1024

def inside(root: Path, rel: str) -> Path | None:
    p = root / rel
    try:
        return p if p.resolve().is_relative_to(root.resolve()) else None
    except (OSError, RuntimeError):
        return None

def open_regular(root: Path, rel: str):
    # A binary handle on root/rel, or None: outside root, a final link, not a regular file.
    p = inside(root, rel)
    if p is None:
        return None
    try:
        fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    fh = os.fdopen(fd, "rb")
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        fh.close()
        return None
    return fh

def sha_file(root: Path, rel: str) -> str:
    fh = open_regular(root, rel)
    if fh is None:
        return "missing"
    h = hashlib.sha256()
    with fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()

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
    # Sources never reach argv — they are hashed and deleted inside the snapshot, through
    # `inside` — so the only lexical rule is: relative, no empty, `.` or `..` segment.
    return isinstance(s, str) and "\0" not in s and all(seg not in ("", ".", "..") for seg in s.split("/"))

def in_tree(root: Path, rel: str) -> bool:
    p = inside(root, rel)
    return p is not None and p.is_file()

# `.dev/stack.yml` is read by a YAML parser, never by hand: Bun.YAML (bun >= 1.2.21).
# bun runs in an empty temp dir on stdin, so no bunfig.toml or package.json of the
# checkout is loaded. It prints the `commands` mapping as JSON, a non-string value as a
# `{nonstring}` marker — JSON would turn `.nan` / `.inf` into null, i.e. "unset".
YAML_JS = r"""
const say = (v) => { console.log(JSON.stringify(v)); process.exit(0) }
if (typeof Bun.YAML?.parse !== 'function') say({ error: 'bun >= 1.2.21 is required (Bun.YAML)', old: true })
let doc
try { doc = Bun.YAML.parse(await Bun.stdin.text()) } catch (e) { say({ error: String(e) }) }
if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) say({ error: 'not a mapping' })
const c = doc.commands
if (c === null || c === undefined) say({ commands: null })
if (typeof c !== 'object' || Array.isArray(c)) say({ commands: '<not a mapping>' })
say({ commands: Object.fromEntries(Object.entries(c).map(([k, v]) =>
  [k, typeof v === 'string' || v === null || v === undefined ? (v ?? null) : { nonstring: typeof v }])) })
"""

def contract_test_argv() -> tuple[list[str] | None, str, str]:
    # (argv, "", "") or (None, reason, why).
    repo = Path.cwd()
    stack = repo / ".dev/stack.yml"
    if not stack.exists() and not stack.is_symlink():
        return None, "missing-test-command", "no .dev/stack.yml"
    fh = open_regular(repo, ".dev/stack.yml")
    if fh is None:
        return None, "unsupported-test-command", ".dev/stack.yml is not a regular file inside the checkout"
    with fh:
        text = fh.read(CONTRACT_CAP + 1)
    if len(text) > CONTRACT_CAP:
        return None, "unsupported-test-command", f".dev/stack.yml is larger than {CONTRACT_CAP} bytes"
    bun = shutil.which("bun")
    if bun is None:
        return None, "unsupported-test-command", "bun is required to read .dev/stack.yml"
    with tempfile.TemporaryDirectory(prefix="rf-yaml.") as neutral:
        r = subprocess.run([bun, "-e", YAML_JS], input=text, cwd=neutral, capture_output=True, timeout=60)
    try:
        parsed = json.loads(r.stdout)
    except json.JSONDecodeError:
        return None, "unsupported-test-command", "bun could not read .dev/stack.yml"
    if "error" in parsed:
        if parsed.get("old"):
            return None, "unsupported-test-command", parsed["error"]
        return None, "unsupported-test-command", f".dev/stack.yml is not valid YAML ({parsed['error'][:120]})"
    commands = parsed["commands"]
    if commands is None:
        return None, "missing-test-command", "no `commands` mapping"
    if not isinstance(commands, dict):
        return None, "unsupported-test-command", "`commands` is not a mapping"
    for key in CONTRACT_KEYS:
        value = commands.get(key)
        if value is None or value == "":
            continue  # unset: `test_file` falls back to `test`
        if not isinstance(value, str):
            return None, "unsupported-test-command", f"commands.{key} is not a string"
        # No shell runs it: plain words only, and argv[0] is not a `VAR=value` prefix.
        argv = re.split(r"[ \t]+", value.strip(" \t"))  # str.strip() would eat \x1c or U+2028
        if "=" in argv[0] or not all(PLAIN_TOKEN.fullmatch(t) for t in argv):
            return None, "unsupported-test-command", f"commands.{key} is not one plain command"
        return argv, "", ""
    return None, "missing-test-command", "neither commands.test_file nor commands.test is set"

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
    # The snapshot is not a repository, and must not find one above it either (a TMPDIR
    # inside a work tree): git discovery stops at the snapshot's parent.
    env = {**os.environ, "GIT_CEILING_DIRECTORIES": str(cwd.parent)}
    try:
        r = subprocess.run(argv, cwd=str(cwd), capture_output=True, text=True, env=env)
    except OSError as e:
        return 127, str(e)[:240]
    out = (r.stdout or "") + (r.stderr or "")
    return r.returncode, out.replace("\n", " ")[:240]

def write_text_nofollow(path: Path, text: str) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(text)

def write_artifacts(out: Path, issue, head: str, ok: bool, reason: str, rows: list) -> None:
    # A relative --out is a checkout path (`artifacts/reviews/{N}-falsify.json`), which the
    # PR may have committed as a link: it must stay inside the checkout, and no final link
    # is followed — the run writes its record, never through somebody else's file.
    if not out.is_absolute() and inside(Path.cwd(), str(out.parent)) is None:
        raise RuntimeError(f"--out {str(out)!r} resolves outside the checkout")
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
    write_text_nofollow(out, json.dumps(doc, indent=2) + "\n")
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
    write_text_nofollow(md, "\n".join(lines) + "\n")

def snapshot_repo(dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    # HEAD tree — argv pipe, no shell anywhere in the runner
    archive = subprocess.Popen(["git", "archive", "HEAD"], stdout=subprocess.PIPE)
    subprocess.run(["tar", "-x", "-C", str(dest)], stdin=archive.stdout, check=True)
    archive.stdout.close()
    if archive.wait() != 0:
        raise subprocess.CalledProcessError(archive.returncode, ["git", "archive", "HEAD"])
    # Overlay the working tree. A tracked link that stays inside the checkout is carried as
    # a link, so the guards see it. Any other link is local environment — a worktree's
    # `.venv -> <main>/.venv`, untracked or staged — and is never carried: `uv run` would
    # re-sync the main venv through it. Every write goes through `inside`.
    repo = Path.cwd()
    for tracked, flag in ((True, "-c"), (False, "-o")):
        r = subprocess.run(["git", "ls-files", flag, "--exclude-standard", "-z"], capture_output=True)
        for raw in r.stdout.split(b"\0"):
            if not raw:
                continue
            rel = raw.decode("utf-8", "surrogateescape")
            src = Path(rel)
            if src.is_symlink() and (not tracked or inside(repo, rel) is None):
                continue
            if not (src.is_symlink() or src.is_file()):
                continue
            if inside(dest, str(src.parent)) is None:
                raise RuntimeError(f"overlay path {rel!r} escapes the snapshot")
            target = dest / rel
            if target.is_symlink() or target.is_file():
                target.unlink()
            target.parent.mkdir(parents=True, exist_ok=True)
            if src.is_symlink():
                os.symlink(os.readlink(src), target)
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
        if dep.is_symlink() or not dep.is_dir() or inside(dest, str(dep.parent)) is None:
            continue
        target = dest / dep
        if target.is_symlink():
            target.unlink()  # an archive link must not become the place links are written
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
    # The snapshot keeps tracked links and dependency links, so a lexically plain source
    # can still resolve outside it: refuse instead of deleting.
    for s in sources:
        p = inside(root, s)
        if p is None:
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

    base, base_reason, base_why = contract_test_argv()
    if base is None:
        print(
            f"run-falsify: {base_reason}: {base_why}. .dev/stack.yml commands.test_file (else "
            "commands.test) must be one plain command: plain words, no shell syntax, no VAR= prefix",
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
        failures = []  # the first failing row names the reason, not the last

        for row, argv in zip(rows_in, argvs):
            sc = row.get("sc_id", "")
            sources = list(row.get("sources") or [])
            test_cmd = shlex.join(argv)
            hashes = {s: sha_file(wt, s) for s in sources}

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
                    failures.append("source-escape")
                    continue

                fail_ec, fail_out = run_cmd(fail_dir, argv)
                if fail_ec == 0:
                    rows_out.append({
                        "sc_id": sc, "sources": sources, "source_hashes": hashes,
                        "test_cmd": test_cmd, "fail_exit": 0, "pass_exit": 1,
                        "error": "TAUTOLOGICAL: passed with sources absent",
                        "status": "failed",
                    })
                    failures.append("tautology")
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
                    failures.append("restore-failed")
                    rows_out.append({
                        "sc_id": sc, "sources": sources, "source_hashes": hashes,
                        "test_cmd": test_cmd, "fail_exit": fail_ec, "pass_exit": pass_ec,
                        "error": f"restore-failed exit={pass_ec}", "status": "failed",
                    })
            finally:
                shutil.rmtree(fail_dir, ignore_errors=True)

        ok = any_proven and not failures
        reason = "ok" if ok else (failures[0] if failures else "no-proven-row")

        if out_path is None:
            out_path = Path(f"artifacts/reviews/{issue}-falsify.json")
        write_artifacts(out_path, issue, head, ok, reason, rows_out)
        return ok, reason
    finally:
        shutil.rmtree(wt, ignore_errors=True)

def verify(json_path: Path) -> tuple[bool, str]:
    # Read like every other PR path: a regular file, no final link (an absolute path is the
    # caller's own choice; a relative one must stay inside the checkout).
    fh = open_regular(Path("/") if json_path.is_absolute() else Path.cwd(), str(json_path))
    if fh is None:
        return False, "missing-artifact"
    with fh:
        raw = fh.read()
    try:
        doc = json.loads(raw.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
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
)" || true
  # Parse last oracle_ok/reason lines from python stdout. No line at all means python
  # died without a verdict (a signal, an OOM kill): that is still a verdict, and false.
  ORACLE_OK="$(printf '%s\n' "$out" | sed -n 's/^oracle_ok=//p' | tail -1)"
  ORACLE_REASON="$(printf '%s\n' "$out" | sed -n 's/^oracle_reason=//p' | tail -1)"
  if [ -z "$ORACLE_OK" ]; then
    ORACLE_OK=false
    ORACLE_REASON=runner-error
    rf_emit
  else
    printf '%s\n' "$out"
  fi
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
