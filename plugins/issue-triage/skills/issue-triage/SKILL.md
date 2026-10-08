---
name: issue-triage
argument-hint: '[list | set <num> | create --title "..." [--parent N] [--size S] [--priority P] [--type T] [--lane L]]'
description: Triage/create GitHub issues — set size/priority/lane/type labels, manage dependencies & parent/child. Run before `/feature` picks a ticket up. Triggers: "triage" | "create issue" | "set size" | "set priority" | "blocked by" | "set parent" | "child of" | "sub-issue" | "file an issue" | "log a bug" | "open an issue" | "file a bug" | "add issue" | "new issue" | "set lane" | "set type".
version: 0.6.0
allowed-tools: Bash, Read, ToolSearch
---

# Issue Triage

Let: T := `bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts` — triage CLI | κ := complexity score

Default: `T` or `T list` (no args = list).

Create GitHub issues, assign Size/Priority labels, manage blockedBy dependencies and parent/child relationships.

This skill owns every issue write: creation, `size:` tier, priority, type, and the
native relations. Nothing else writes them — not `gh issue create`, not a
`Blocked by:` line in a body. The project contract is `docs/agents/issue-tracker.md`.

It runs **before** the delivery cycle, not inside it. `/feature` mutates tickets
only through issue-triage.

## Instructions

1. List all open issues: `T` / `T list` | List untriaged only: `T list --untriaged`
2. ∀ issue: determine Size, κ (see [Complexity Scoring](#complexity-scoring)) and Priority (see [Priority Guidelines](#priority-guidelines))
3. Set values: `T set <number> --size <S> --priority <P>`
4. Create issues: `T create --title "Title" [--body "Body"] [--label "bug,frontend"] [--size M] [--priority High] [--type feat] [--lane b] [--parent 163]`
5. Adopt a repository: `T init [--dry-run] [--repo owner/repo]`. Writes `docs/agents/issue-tracker.md` only when that file is absent, and only at the git toplevel — not the process cwd. An existing contract is authoritative: init prints `contract: keep-existing` and never rewrites it. Labels come from its `Label | Colour` table (a leading pipe is optional), or from canonical names in the template list; `bug` and other non-canonical snapshot entries are not a vocabulary. `epic` and `reviewed` are created only when that vocabulary lists them. An existing label is never recoloured; a case mismatch is reported, not created. A contract that parses to no vocabulary prints `vocabulary: none parsed from docs/agents/issue-tracker.md` and exits non-zero. `--repo` other than the local repo is refused: the local file is not that repo's vocabulary. A relabel target outside the vocabulary and the repo labels is refused before any write.
6. → ask userif unsure about Size ∨ Priority.

## Size Guidelines

| Size | Description | Example |
|------|-------------|---------|
| **XS** | Trivial, < 1 hour | Typo fix, config tweak |
| **S** | Small, < 4 hours | Single file change, simple feature |
| **M** | Medium, 1-2 days | Multi-file feature, requires testing |
| **L** | Large, 3-5 days | Complex feature, architectural changes |
| **XL** | Very large, > 1 week | Major refactor, new system |

**Canonical labels written:** `size:S` / `size:F-lite` / `size:F-full`. `--size` also accepts legacy `XS / S / M / L / XL` and aliases them (`XS`→`S`, `M`→`F-lite`, `L`/`XL`→`F-full`).

## Priority Guidelines

The project contract (`docs/agents/issue-tracker.md`) binds this rubric to the repository (which epic is the milestone, what counts as shipped) and wins where it differs.

| Priority | When | Action |
|----------|------|--------|
| **Urgent** (P0) | Blocking now: the default branch or a release is blocked, or a security incident is live | Do immediately |
| **High** (P1) | The milestone in progress, or a shipped check that lies (see below) | Do this sprint |
| **Medium** (P2) | A real defect or debt that does not lie: a check that refuses too much or names the wrong cause, a misleading doc, a correctness gap outside the milestone | Plan for next sprint |
| **Low** (P3) | Backlog: test hardening, deferred non-blocking findings, slices of a parked epic | Backlog |

P1 has two independent triggers; either one is enough:

1. **Milestone.** The open `epic` that carries P1 needs the ticket to close or to keep its promise. Being that epic's child is not enough: a deferred non-blocking finding under it stays P2 or P3.
2. **A shipped check that lies.** A gate, guard, verifier or success predicate in shipped code reports a pass when it should fail or stop: a wrong-green gate, a fail-open verifier, a guard that no longer halts. This holds whatever the milestone. A check that fails closed (it refuses too much, or names the wrong cause) is P2.

An epic caps its feature slices, not its defects: a feature child sits at or below its epic, and a child that matches trigger 2 is P1 under any epic.

Every priority change carries a comment that names the trigger and the evidence, so the next triage can tell a decision from drift.

## Commands

### `list` — Show open issues

| Flag | Description |
|------|-------------|
| *(none)* | Tree of all open issues with N-level parent-child hierarchy. Parents with ≥1 closed child show `… ✓ Done`. |
| `--untriaged` | Flat table of issues missing Size or Priority |
| `--json` | JSON output (all open issues); combine with `--untriaged` to filter |

### `set <num>` — Update an existing issue

| Flag | Description |
|------|-------------|
| `--size <S>` | Set size label — canonical `S/F-lite/F-full` or legacy `XS/S/M/L/XL` (canonical names alias to nearest legacy label) |
| `--priority <P>` | Set priority label. Accepts `Urgent/High/Medium/Low`, `P0`–`P3`, and the label spelling `P0-critical`/`P1-high`/`P2-medium`/`P3-low`. Anything else exits 1 |
| `--blocked-by <REF>[,<REF>...]` | Add blocked-by dependency. REF = `#N` or `owner/repo#N` |
| `--blocks <REF>[,<REF>...]` | Add blocking dependency. REF = `#N` or `owner/repo#N` |
| `--rm-blocked-by <REF>[,<REF>...]` | Remove blocked-by dependency |
| `--rm-blocks <REF>[,<REF>...]` | Remove blocking dependency |
| `--parent <REF>` | Set parent issue. REF = `#N` or `owner/repo#N` |
| `--add-child <REF>[,<REF>...]` | Add child sub-issues |
| `--rm-parent` | Remove parent relationship. Refused for a cross-repo subject before any write |
| `--rm-child <REF>[,<REF>...]` | Remove child sub-issues |
| `--lane <L>` | Set lane label (optional, additive). Valid: `a1`, `a2`, `a3`, `b`, `c1`, `c2`, `c3`, `d`–`o`, `standalone` — case-folded; anything else exits 1 |
| `--type <T>` | Set org issueType (optional, additive). Valid: `fix`, `feat`, `docs`, `test`, `chore`, `ci`, `perf`, `epic`, `research`, `refactor` |
| `--body <text>` | Replace the issue body. Empty, whitespace-only, or a value equal to a known `set` flag exits 1 and writes nothing. Not a clear |
| `--body-file <path>` | Replace the issue body with the file's bytes. A missing file, an empty or whitespace-only file, or a path that is a known `set` flag exits 1 and writes nothing. Last of `--body` / `--body-file` wins |
| `--clear-body` | Write an empty body. The only clear. Combined with `--body` or `--body-file`, exits 1 and writes nothing |

Every flag is canonicalised, and every lookup that can reject the command (type id, parent / child / blocked-by node id, a relation token that does not parse) is resolved, **before** the first write. A rejected value leaves the issue untouched, including the body. The body `PATCH` is the last write. A rejected `PATCH` exits non-zero and names the HTTP status; it does not roll back label or relation writes that already landed in that invocation. A label that the repository does not carry is reported and exits 1 **after** the dependency and parent/child writes, and **before** the body `PATCH`. A flag given no value (`--priority` with nothing after it, or `--priority "$UNSET"`) exits 1 rather than being ignored.

On success, a body replace prints `Body #N` or `Body owner/repo#N`.

`set` on a pull-request number rewrites the PR description: `PATCH /repos/{owner}/{repo}/issues/{n}` applies to PRs. `set` does not GET the target to refuse one.

### `create` — Create a new issue

| Flag | Description |
|------|-------------|
| `--title "..."` | Issue title (**required**, or `--title-file`) |
| `--title-file <path>` | Read the title from a file (trimmed). Use it for text you did not write |
| `--body "..."` | Issue body/description |
| `--body-file <path>` | Read the body from a file. Use it for text you did not write: `$(…)` or a backtick in a double-quoted `--body` runs in your shell |
| `--label "l1,l2"` | Comma-separated labels |
| `--size <S>` | Set size on creation — canonical `S/F-lite/F-full` or legacy `XS/S/M/L/XL` accepted |
| `--priority <P>` | Set priority on creation — same spellings as `set --priority`. An unrecognised value exits 1 **before** the issue is created |
| `--lane <L>` | Set lane on creation (label-only, additive). Valid: `a1`, `a2`, `a3`, `b`, `c1`, `c2`, `c3`, `d`–`o`, `standalone` — case-folded; anything else exits 1 |
| `--status <S>` | Set status label. Valid: `Backlog`, `Analysis`, `Specs`, `In Progress`, `Review`, `Done`. Legacy — `set` rejects `--status` outright in the issues-only model |
| `--type <T>` | Set org issueType on creation (additive). Valid: `fix`, `feat`, `docs`, `test`, `chore`, `ci`, `perf`, `epic`, `research`, `refactor` |
| `--parent <REF>` | Set parent issue on creation. REF = `#N` or `owner/repo#N` |
| `--add-child <REF>[,<REF>...]` | Add existing issues as children |
| `--blocked-by <REF>[,<REF>...]` | Set blocked-by on creation |
| `--blocks <REF>[,<REF>...]` | Set blocking on creation |

### Cross-repo create

Set `GITHUB_REPO=<owner/repo>` to retarget the CREATE to a different repo than the cwd's git remote:

```bash
# File a voiceCLI issue while cwd is lyra (or any other repo)
GITHUB_REPO=Roxabi/voiceCLI T create \
  --title 'STT: audio dropout at segment boundary' \
  --blocked-by Roxabi/lyra#728
```

Cross-repo **relations** (`--blocked-by`, `--blocks`, `--parent`, `--add-child`) accept `OWNER/REPO#N` natively — they work regardless of `GITHUB_REPO`.

**Caveat — keep refs fully-qualified:** `GITHUB_REPO` retargets the entire invocation. A bare `#N` in any ref resolves against the overridden repo, not the cwd repo → always use `OWNER/REPO#N` for any cross-repo ref when the env var is set.

**Resolution order** (`detectGitHubRepo`): (1) `github_repo` in dev-core config ∨ `GITHUB_REPO` env var (validated as `owner/repo`) → (2) fallback `git remote get-url origin` of the cwd.

## Deferred Follow-Ups — Sibling Rule

**Defer ≠ decomposition.** When an issue A defers work to a new follow-up B (out-of-scope finding, post-merge gap, "do this later"), B is a **sibling** of A under their shared parent — NOT a child of A. That sibling default stays. Do not implement the exception below by deleting it.

```
       Epic E
      ╱      ╲
     A ←—————— B     B.parent = A.parent (= E)
       blocked-by    B.blocked-by = A   (traceability of origin)
```

The diagram is the default, not the exception.

**Why (default):**
- `gh issue view E` shows the full fan-out flat (A + B + future C…) — true scope of the epic, ¬nested cascade
- A frontier query lands on the origin epic for every follow-up that kept the shared parent, however deep the deferral chain
- Multi-level deferrals (A→B→C) stay flat under E — ¬arbre profond ingérable

**Decomposition vs deferral:**

| Pattern | Parent-child? | Example |
|---------|---------------|---------|
| **Epic → phase** (planned decomposition) | ✓ child of epic | `to-spec` splits an epic: phase 1, phase 2 are children of it. Planned delivery slices stay children, including of the active delivery epic |
| **Issue → follow-up** (deferral, post-hoc) | ✗ sibling under shared parent | Default. A new nonblocking deferral whose candidate parent is the active open delivery epic omits `--parent` instead |
| **Bug → regression** (related ¬caused) | ✗ standalone | New bug surfaced post-merge, ¬child, ¬sibling necessarily |

**Exception — new nonblocking, active delivery epic only.** One case supersedes `B.parent = A.parent`. All of these must hold:

- B is new (`EXISTING_ISSUE` empty). An open issue that already tracks the item is reuse, not this exception.
- `DISPOSITION=nonblocking`. A blocking per-finding filing and the blocking final epic-fix stay children of the delivery epic. A blocking cause that cannot be applied stays a delivery child.
- `SOURCE_PARENT` equals a non-empty `ACTIVE_EPIC`.

Then omit `--parent`. Do not create an epic to hold B. Exclusion is that absent parent edge only. It is not a priority filter (no `P3-low` skip, no new flag, no scheduler state) and not a missing acceptance heading (`hasScope` is not the mechanism). A fresh B still opens with `**Origin:**`, still has `## Acceptance criteria` and a `size:` label, and still takes a native `--blocked-by` to the origin issue when one exists.

`ACTIVE_EPIC` is the open epic the goal loop is delivering. It is not inferred from `P1`, priority, labels, or a hardcoded number. Empty means a successful fresh goal read proved no active epic, and the sibling default stays. Unset, or a failed, malformed, or unresolved goal read, is not that empty: halt before any create or relation write. `skill://fix` § Filing establishes `DISPOSITION` and `ACTIVE_EPIC` (feature supplies the epic it is delivering; a standalone run uses that same fresh goal read). This fence consumes those facts. It does not re-read goal state, and it does not add a tracker parser. Whether a reused body must gain an item is that filing recipe's conservation decision.

Final-review origin E may itself have a parent H. The explicit nonblocking self-candidate (`SOURCE_ISSUE=SOURCE_PARENT=ACTIVE_EPIC`) resolves to that live H, preserving the sibling default outside E. Only a proven top-level E keeps E as the candidate to omit. Blocking epic-fix tickets still parent to E.

**Reuse.** `EXISTING_ISSUE` is only a candidate. Empty means discovery succeeded and found no open cover. Unset, or a failed search, must not be passed as empty — halt, do not create. Before reuse, re-read live state: the issue must be `OPEN`, its body readable, and its complete comment history retrieved with pagination. `ITEM_COVERAGE` is the agent's explicit decision from that body, all comments and proposed additions: `exact` or `noncovering`; title similarity is not coverage. Missing coverage, failed/incomplete reads, or `noncovering` halt with no create. Several open trackers and no single covering issue → halt before mutation, push, or receipt. Reuse preserves body and relations, whether detached or a historical child. A non-whitespace `FILE_DIR/append.md` is published as an append-only issue comment; record its URL in the Deferred receipt. A failed write may already exist: re-read all comments before retry, never create another issue or post a success receipt on failure.

**Recipe — defer A → create follow-up B.** Facts, not new CLI flags. Names match `skill://fix` § Filing. Every listed name must be set before the fence; unset halts. Empty is known absence only where noted, never a failed read. Bare positive integers, never `#N`. The omit comparison is that recipe's comparison: fresh, `DISPOSITION=nonblocking`, and `SOURCE_PARENT` equals a non-empty `ACTIVE_EPIC`.

```bash
set -euo pipefail
# GITHUB_REPO is this skill's existing env, not a new filing fact. Empty resolves against the cwd.
if [ -z "${GITHUB_REPO:-}" ]; then
  echo "Error: GITHUB_REPO unresolved; refusing to create" >&2
  exit 1
fi
case "$GITHUB_REPO" in
  */*) ;;
  *) echo "Error: GITHUB_REPO unresolved; refusing to create" >&2; exit 1 ;;
esac
OWNER=${GITHUB_REPO%%/*}
REPO=${GITHUB_REPO#*/}
case "$OWNER" in ""|*/*) echo "Error: GITHUB_REPO unresolved; refusing to create" >&2; exit 1 ;; esac
case "$REPO" in ""|*/*) echo "Error: GITHUB_REPO unresolved; refusing to create" >&2; exit 1 ;; esac
if [ -z "${DISPOSITION+x}" ] || [ -z "${SOURCE_ISSUE+x}" ] || [ -z "${SOURCE_PARENT+x}" ] \
  || [ -z "${ACTIVE_EPIC+x}" ] || [ -z "${EXISTING_ISSUE+x}" ] || [ -z "${FILE_DIR+x}" ]; then
  echo "Error: filing facts unresolved; refusing to create" >&2
  exit 1
fi
case "$DISPOSITION" in
  blocking|nonblocking) ;;
  *) echo "Error: invalid DISPOSITION; refusing to create" >&2; exit 1 ;;
esac
is_num() {
  case "$1" in ''|*[!0-9]*|0*) return 1 ;; *) return 0 ;; esac
}
if [ -n "$SOURCE_ISSUE" ] && ! is_num "$SOURCE_ISSUE"; then
  echo "Error: SOURCE_ISSUE unresolved; refusing to create" >&2
  exit 1
fi
if [ -n "$SOURCE_PARENT" ] && ! is_num "$SOURCE_PARENT"; then
  echo "Error: SOURCE_PARENT unresolved; refusing to create" >&2
  exit 1
fi
if [ -n "$ACTIVE_EPIC" ] && ! is_num "$ACTIVE_EPIC"; then
  echo "Error: ACTIVE_EPIC unresolved; refusing to create" >&2
  exit 1
fi
if [ -n "$EXISTING_ISSUE" ] && ! is_num "$EXISTING_ISSUE"; then
  echo "Error: EXISTING_ISSUE unresolved; refusing to create" >&2
  exit 1
fi
# A number with no origin has no successful parent read. Do not invent one.
if [ -z "$SOURCE_ISSUE" ] && [ -n "$SOURCE_PARENT" ]; then
  echo "Error: SOURCE_PARENT set without an origin; refusing to create" >&2
  exit 1
fi
if [ -z "$FILE_DIR" ] || [ ! -d "$FILE_DIR" ]; then
  echo "Error: FILE_DIR unresolved; refusing to create" >&2
  exit 1
fi
# 1. Parent read, only when an origin issue exists. Failure is not empty.
A_PARENT=""
if [ -n "$SOURCE_ISSUE" ]; then
  JQ_PARENT='if (.errors | type) == "array" then error("graphql errors")
elif .data.repository.issue == null or .data.repository.issue.number != '"${SOURCE_ISSUE}"' then error("unresolved issue")
elif (.data.repository.issue | has("parent") | not) then error("malformed parent")
elif .data.repository.issue.parent == null then "ABSENT"
elif (.data.repository.issue.parent.number | type) == "number" and .data.repository.issue.parent.number > 0 then (.data.repository.issue.parent.number | tostring)
else error("malformed parent") end'
  PARENT_MARK=$(gh api graphql \
    -f query='query($o:String!,$n:String!,$num:Int!){repository(owner:$o,name:$n){issue(number:$num){number parent{number}}}}' \
    -f o="$OWNER" -f n="$REPO" -F num="$SOURCE_ISSUE" \
    --jq "$JQ_PARENT") || {
    echo "Error: parent read failed; refusing to treat failure as no parent" >&2
    exit 1
  }
  PARENT_MARK=$(printf '%s' "$PARENT_MARK" | tr -d '[:space:]"')
  case "$PARENT_MARK" in
    ABSENT) A_PARENT="" ;;
    ''|*[!0-9]*|0*)
      echo "Error: parent read unresolved; refusing to treat failure as no parent" >&2
      exit 1
      ;;
    *) A_PARENT="$PARENT_MARK" ;;
  esac
  # Final-review self-candidates resolve to the live enclosing parent, if any.
  if [ "$DISPOSITION" = "nonblocking" ] && [ "$SOURCE_ISSUE" = "$ACTIVE_EPIC" ] && [ "$SOURCE_PARENT" = "$SOURCE_ISSUE" ]; then
    SOURCE_PARENT="${A_PARENT:-$SOURCE_ISSUE}"
  elif [ "$SOURCE_PARENT" = "$A_PARENT" ]; then
    :
  else
    echo "Error: parent bindings disagree; refusing to create" >&2
    exit 1
  fi
fi
# 2. Reuse. Live OPEN, readable body and complete comment history. No relation writes.
if [ -n "$EXISTING_ISSUE" ]; then
  case "${ITEM_COVERAGE:-}" in
    exact) ;;
    noncovering)
      echo "Error: existing issue does not cover the item; refusing to create" >&2
      exit 1
      ;;
    *)
      echo "Error: ITEM_COVERAGE unresolved; refusing to create" >&2
      exit 1
      ;;
  esac
  EXISTING_MARK=$(gh issue view "$EXISTING_ISSUE" --repo "$GITHUB_REPO" --json state,body \
    --jq 'if .state != "OPEN" then "NOT_OPEN" elif .body == null then "NO_BODY" else "OPEN" end') || {
    echo "Error: existing-issue read failed; refusing to create or reuse" >&2
    exit 1
  }
  EXISTING_MARK=$(printf '%s' "$EXISTING_MARK" | tr -d '[:space:]"')
  if [ "$EXISTING_MARK" != "OPEN" ]; then
    echo "Error: existing issue is not an open tracker (${EXISTING_MARK:-unresolved}); refusing to create or reuse" >&2
    exit 1
  fi
  gh issue view "$EXISTING_ISSUE" --repo "$GITHUB_REPO" --json body --jq .body > "$FILE_DIR/prior-body.md" || {
    echo "Error: existing-issue body read failed; refusing to create or reuse" >&2
    exit 1
  }
  gh api --paginate "repos/${GITHUB_REPO}/issues/${EXISTING_ISSUE}/comments" --jq '.[].body' > "$FILE_DIR/prior-comments.md" || {
    echo "Error: complete comment history unreadable; refusing to create or reuse" >&2
    exit 1
  }
  if [ -f "$FILE_DIR/append.md" ] && grep -q '[^[:space:]]' "$FILE_DIR/append.md"; then
    log=$(mktemp)
    set +e
    gh issue comment "$EXISTING_ISSUE" --repo "$GITHUB_REPO" --body-file "$FILE_DIR/append.md" >"$log" 2>&1
    status=$?
    set -e
    cat "$log"
    rm -f "$log"
    if [ "$status" -ne 0 ]; then
      echo "tracker partial failure: issue #${EXISTING_ISSUE}; re-read all comments before retry; do not create again" >&2
      exit "$status"
    fi
  fi
  echo "reuse #${EXISTING_ISSUE}: no create, no relation writes" >&2
  exit 0
fi
if [ -n "${ITEM_COVERAGE:-}" ]; then
  echo "Error: ITEM_COVERAGE set without an existing issue; refusing to create" >&2
  exit 1
fi
# 3. Fresh create. Omit --parent only for the nonblocking active-epic exception.
if [ -z "${SOURCE_SIZE:-}" ]; then
  echo "Error: SOURCE_SIZE unresolved; refusing to create" >&2
  exit 1
fi
case "$SOURCE_SIZE" in
  *[[:space:]]*) echo "Error: SOURCE_SIZE unresolved; refusing to create" >&2; exit 1 ;;
esac
if [ ! -f "$FILE_DIR/title.txt" ] || [ ! -f "$FILE_DIR/body.md" ]; then
  echo "Error: FILE_DIR payload unresolved; refusing to create" >&2
  exit 1
fi
if ! grep -q '[^[:space:]]' "$FILE_DIR/title.txt" || ! grep -q '[^[:space:]]' "$FILE_DIR/body.md"; then
  echo "Error: FILE_DIR payload unresolved; refusing to create" >&2
  exit 1
fi
if ! grep -q '^\*\*Origin:\*\*' "$FILE_DIR/body.md" || ! grep -q '^## Acceptance criteria$' "$FILE_DIR/body.md"; then
  echo "Error: fresh body missing Origin or acceptance heading; refusing to create" >&2
  exit 1
fi
if [ -f "$FILE_DIR/append.md" ] && grep -q '[^[:space:]]' "$FILE_DIR/append.md"; then
  echo "Error: append.md on a fresh create; refusing to create" >&2
  exit 1
fi
OMIT_PARENT=0
if [ "$DISPOSITION" = "nonblocking" ] && [ -n "$SOURCE_PARENT" ] && [ "$SOURCE_PARENT" = "$ACTIVE_EPIC" ]; then
  OMIT_PARENT=1
fi
ARGS=(--title-file "$FILE_DIR/title.txt" --body-file "$FILE_DIR/body.md" --size "$SOURCE_SIZE")
if [ -n "$SOURCE_ISSUE" ]; then
  ARGS+=(--blocked-by "#${SOURCE_ISSUE}")
fi
if [ -n "${SOURCE_TYPE:-}" ]; then
  case "$SOURCE_TYPE" in
    *[[:space:]]*) echo "Error: SOURCE_TYPE unresolved; refusing to create" >&2; exit 1 ;;
  esac
  ARGS+=(--type "$SOURCE_TYPE")
fi
if [ "$OMIT_PARENT" != "1" ] && [ -n "$SOURCE_PARENT" ]; then
  ARGS+=(--parent "#${SOURCE_PARENT}")
fi
# OMIT_PARENT does not create an epic. A non-zero create may already have filed B: reconcile it, do not create again.
log=$(mktemp)
set +e
T create "${ARGS[@]}" >"$log" 2>&1
status=$?
set -e
cat "$log"
if [ "$status" -ne 0 ]; then
  created=$(sed -n 's/^Created #\([0-9][0-9]*\):.*/\1/p' "$log")
  created=${created%%$'\n'*}
  if [ -n "$created" ]; then
    echo "tracker partial failure: created #${created}; reconcile that issue; do not create again" >&2
  fi
  rm -f "$log"
  exit "$status"
fi
rm -f "$log"
```

**Edge cases:**
- Parent read failed, malformed, or unresolved → halt. That is not an empty `SOURCE_PARENT`, and it must not omit `--parent`.
- A has no parent, and the read returned `ABSENT` with `SOURCE_PARENT` empty → B has no parent either, unless planned decomposition applies and A is a top-level epic that is not the active delivery epic. Do not create a holding epic because the fan-out grew. Do not re-parent A under a freshly-created epic for a nonblocking deferral, and never when the only candidate parent is the active delivery epic.
- A is already a top-level epic → planned decomposition still creates a child of A. That child edge is not this exception: the filing is not a new nonblocking deferral, or A is not `ACTIVE_EPIC`. A new nonblocking deferral whose `SOURCE_PARENT` equals `ACTIVE_EPIC` omits `--parent`, including when A is that epic. A different top-level epic still gets the child.
- Existing open tracker → reuse. The repair below is not filing, and filing must not run it.
- Existing follow-up B nested under A → repair only outside filing, only after the successful parent read, and only when that parent is non-empty and is not `ACTIVE_EPIC`. Do not detach a historical child of the delivery epic, do not reattach a detached issue, and do not apply the exception by editing an existing relation:
  ```bash
  if [ -z "${ACTIVE_EPIC+x}" ] || [ -z "${A_PARENT:-}" ] || [ "$A_PARENT" = "$ACTIVE_EPIC" ]; then
    echo "Error: refusing to re-parent; absent or active-delivery parent is not a repair" >&2
    exit 1
  fi
  T set <B> --rm-parent
  T set <B> --parent "#${A_PARENT}"
  T set <B> --blocked-by "#${A}"
  ```

## Complexity Scoring

Assess κ ∈ [1,10] to inform tier (S / F-lite / F-full). Record by replacing an existing marker, or appending one, through `set --body-file`. A failed or empty read must not write. The read and the write use the same non-empty repo slug (env, then `.dev/dev-core.yml` `github_repo`, then the cwd). An empty slug must abort before `gh issue view`: that command ignores an empty repo flag and exits 0 against the cwd.

```bash
set -euo pipefail
N=<number>
SCORE=<score>
REPO="${GITHUB_REPO:-}"
if [ -z "$REPO" ] && [ -f .dev/dev-core.yml ]; then
  REPO=$(sed -n "s/^github_repo:[[:space:]]*['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}[[:space:]]*$/\1/p" .dev/dev-core.yml | head -n 1)
fi
if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi
if [ -z "$REPO" ]; then
  echo "Error: empty repo; refusing to read one repo and write another" >&2
  exit 1
fi
BODY=$(gh issue view "$N" --repo "$REPO" --json body --jq .body) || exit 1
if [ "$BODY" = "null" ]; then
  BODY=""
fi
trimmed=$(printf '%s' "$BODY" | tr -d '[:space:]')
if [ -z "$trimmed" ]; then
  echo "Error: empty body read; refusing to write a marker-only body" >&2
  exit 1
fi
MARKER="<!-- complexity: ${SCORE} -->"
case "$BODY" in
  *'<!-- complexity:'*)
    NEW=$(printf '%s' "$BODY" | sed -E "s/<!-- complexity: [0-9]+ -->/${MARKER}/")
    if [ "$NEW" = "$BODY" ]; then
      echo "Error: complexity marker matched but was not replaced" >&2
      exit 1
    fi
    ;;
  *)
    NEW=$(printf '%s\n\n%s\n' "$BODY" "$MARKER")
    ;;
esac
DIR=$(mktemp -d)
printf '%s\n' "$NEW" > "$DIR/body.md"
GITHUB_REPO="$REPO" T set "${REPO}#${N}" --body-file "$DIR/body.md"
rm -rf "$DIR"
```

**Factors (each 1-10, weighted):**

| Factor | Weight | 1 (Low) | 5 (Medium) | 10 (High) |
|--------|--------|---------|------------|-----------|
| **Files touched** | 20% | 1-3 files | 5-10 files | 15+ files |
| **Technical risk** | 25% | Known patterns | New library/pattern in 1 domain | New architecture |
| **Architectural impact** | 25% | Single module | Shared types, 2 modules | Cross-domain, new abstractions |
| **Unknowns count** | 15% | 0 unknowns | 1-2 open questions | 3+ unknowns |
| **Domain breadth** | 15% | 1 domain | 2 domains | 3+ domains |

**Formula:** `κ = round(files × 0.20 + risk × 0.25 + arch × 0.25 + unknowns × 0.15 + domains × 0.15)`

**Tier mapping:**

| Score | Tier | Label written |
|-------|------|---------------|
| 1-3 | **S** | `size:S` |
| 4-6 | **F-lite** | `size:F-lite` |
| 7-10 | **F-full** | `size:F-full` |

The label is the **only** source of the review tier — `R-dev-review` reads τ from
the issue, so a ticket created without a `size:` label silently downgrades its own
review to `F-lite`. What each tier costs downstream is the project contract's to
state, not this skill's: `docs/agents/issue-tracker.md` § Tier is mandatory.

κ is advisory. Human judgment overrides. → ask userif score ≠ intuition.

## Example Workflow

```bash
T list
T list --untriaged
T set 42 --size M --priority High
T set 91 --blocked-by 117
T set 117 --blocks 91,118
T set 91 --rm-blocked-by 117
T set 164 --parent 163
T set 163 --add-child 164,165,166
T set 164 --rm-parent
T set 163 --rm-child 166

# Cross-repo dependencies (owner/repo#N format)
T set 42 --blocked-by Roxabi/lyra#728
T set 42 --blocks Roxabi/voiceCLI#94

T create \
  --title "research: compare against example/repo" \
  --body "Deep analysis of example/repo" \
  --label "research" \
  --size S --priority Medium \
  --parent 163
T create \
  --title "epic: improve CI pipeline" \
  --size L --priority High \
  --add-child 150,151,152

# Lane and type (additive, optional)
T set 42 --lane b
T set 42 --type feat
T set 42 --size M --priority High --lane c1 --type fix
```

## Completion

- **Success:** print one line: `Done. Next: /feature #N`. Stop.
- **Failure:** return error.

$ARGUMENTS
