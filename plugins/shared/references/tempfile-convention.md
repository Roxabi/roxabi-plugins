# Tempfile Convention

Shared rule for skills that write a transient body/payload to disk before handing it to another tool (e.g. `gh pr comment --body-file`, `curl --data-binary @file`, agent payload drops).

Load via: `Read ${CLAUDE_PLUGIN_ROOT}/../shared/references/tempfile-convention.md`

## Why

Fixed paths like `/tmp/review-comment.md` collide when:
- two `/dev` runs execute in parallel on different branches
- a skill re-runs in the same session (fix → re-review loop)
- two developers share a host (rare, but possible)

A collision silently overwrites a peer's body before the consumer tool reads it → wrong comment posted, wrong payload sent.

## Rule

1. Create a **temp directory** with `mktemp -d` — kernel-guaranteed unique, mode 700, race-free via `O_EXCL`.
2. Use a **readable template** so `/tmp` stays debuggable.
3. **Single `trap ... EXIT`** that removes the whole directory — no stacking issue, covers N files for the cost of 1 trap.

## Pattern

### Single tempfile

```bash
TMPDIR=$(mktemp -d -t "<plugin>-<purpose>-<scope>-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
BODY="$TMPDIR/body.md"

cat > "$BODY" <<'EOF'
… body content …
EOF

gh pr comment "$PR" --body-file "$BODY"
```

### Multiple tempfiles in one invocation

```bash
TMPDIR=$(mktemp -d -t "<plugin>-<purpose>-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
BODY="$TMPDIR/body.md"
DIFF="$TMPDIR/diff.patch"
LOG="$TMPDIR/run.log"
# single trap covers all three
```

### No scope (no invocation-specific tag)

```bash
TMPDIR=$(mktemp -d -t "web-intel-screenshot-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
IMG="$TMPDIR/screenshot.png"
```

## Template slots

- `<plugin>`  — owning plugin (`dev-core`, `web-intel`, `cv`, …)
- `<purpose>` — short noun (`review-comment`, `review-fixes`, `cv-adapted`, `screenshot`)
- `<scope>`   — invocation-specific tag (PR#, issue#, job-id, run-id) — **omit the entire segment including dashes** when none applies

## Input validation

Any user-facing or tool-returned value interpolated into the template **must** be validated before use. The template string is passed to `mktemp -t` which on BSD mktemp can path-traverse if a segment contains `/`.

PR number, for example:
```bash
PR=$(gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number')
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "Invalid PR number: $PR" >&2; exit 1; }
```

Slugs / titles: sanitize to `[a-z0-9-]`:
```bash
SLUG_SAFE=$(echo "$SLUG" | tr -c '[:alnum:]-' '-' | head -c 40)
```

## Example filenames

- `/tmp/dev-core-review-comment-PR42-aB7xQ2/body.md`
- `/tmp/dev-core-review-fixes-PR42-k9mR1p/body.md`
- `/tmp/web-intel-screenshot-Xz4Lm8/screenshot.png`
- `/tmp/cv-adapt-acme-corp-r3Np9Q/adapted.json`

## Limitations

`trap ... EXIT` fires on normal shell exit, SIGINT, SIGTERM, SIGHUP. It does **NOT** fire on:
- `SIGKILL` (signal 9)
- kernel panic / power loss
- `exec` replacing the shell without executing the trap

→ tempfiles may linger on disk. Mode 700 protects against other UIDs but not against processes running as the same user. Treat body content as briefly sensitive (review findings may embed diff snippets redacted in Phase 1.5 but still contextual).

**Mitigation:** `cleanup-context` audits `/tmp/<plugin>-*` entries older than 24h and sweeps them on each run.

## Assumptions

The consumer tool (`gh`, `curl`, `python`) must run on the **same host** as the skill. `mktemp` writes to the local `/tmp`; `gh pr comment --body-file` reads from the same path. If a future runner executes the skill on a remote host but invokes `gh` locally (or vice versa), the file is invisible to the consumer. Pipe via stdin instead for cross-host scenarios.

## When NOT to use mktemp

- **Persistent user data** → `~/.roxabi-vault/<plugin>/` via `roxabi_sdk.paths`, not `/tmp`.
- **Artifact-under-review** (spec, plan, frame) → `artifacts/<kind>/` — versioned, not ephemeral.
- **Cache hit-testing** (tests intentionally asserting a fixed path) → OK to hardcode in `tests/`, never in SKILL.md.

## Enforced by

`cleanup-context/cookbooks/analysis.md` §2e — audit rule greps SKILL.md files for fixed `/tmp/<name>` literals and flags any hit not wrapped in `mktemp`.

`tools/validate_plugins.py` → `check_tempfile_convention()` — CI gate, fails the build on any unguarded `/tmp/` literal in a `plugins/*/skills/**/SKILL.md`.

Both locations reference this doc. If you rename this file, update both sides.
