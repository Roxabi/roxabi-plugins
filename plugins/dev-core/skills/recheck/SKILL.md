---
name: recheck
argument-hint: '[#N | --issue N]'
description: Drift-check an issue before work begins — fails fast when code has evolved (git-drift, symbol-missing, dep-resolved). Triggers: "recheck" | "is this issue still valid" | "check drift" | "check issue staleness".
version: 0.1.0
allowed-tools: Bash, Read, Grep, Glob, Skill, ToolSearch
---

# Recheck

## Success

I := signals computed ∧ (¬signals → silent return) ∨ (signals → DP A presented)

Let:
  N  := issue number
  S  := signal set { git-drift, symbol-missing, dep-resolved }
  M  := mode ∈ { pipeline, standalone }
  DP := decision protocol (see `${CLAUDE_PLUGIN_ROOT}/../shared/references/decision-presentation.md`)

Drift-check N against 3 deterministic signals (no LLM); block pipeline via DP(A) when S ≠ ∅.
Standalone-safe: callable without `/dev`. Invoked by `/dev` between `triage` and `frame`.

## Entry

```
/recheck #N            standalone — signal-fire DP has 3 options (Proceed | Close | Abort)
(invoked by /dev)      pipeline  — signal-fire DP has 4 options (adds Update issue first)
```

## Pipeline

| Step | ID      | Required | Notes                                          |
|------|---------|----------|------------------------------------------------|
| 0    | parse   | ✓        | resolve N, detect M, check `--update-iter` flag |
| 1    | fetch   | ✓        | `gh issue view N --json number,title,body,labels,createdAt` |
| 2    | extract | ✓        | cited paths, symbols, blocked-by numbers from body |
| 3    | check   | ✓        | run 3 drift checks (parallel, deterministic)   |
| 4    | decide  | ✓        | S == ∅ → silent return ; S ≠ ∅ → DP(A)        |

## Step 0 — Parse + Detect Mode

Resolve N from:
- `#N` positional arg → strip `#`
- `--issue N` flag
- `$ARGUMENTS` (bare number)

Detect M:
- `--from-dev` flag present → `pipeline`
- else → `standalone`

Check `--update-iter=2` flag: ∃ → this is the 2nd run after Update; omit **Update issue first** from DP even if signals fire.

Issue N ¬∃ (gh returns 404) → print `Error: issue #N not found.` + exit 1.

## Step 1 — Fetch Issue

```bash
gh issue view N --json number,title,body,labels,createdAt \
  --jq '{number:.number, title:.title, body:.body, labels:[.labels[].name], createdAt:.createdAt}'
```

Note: `gh issue view` does not expose `parent` or `blocked-by` as structured JSON fields. Primary approach: grep body for `blocked by #N`, `blocks #N`, `parent: #N`, `closes #N` patterns (Step 2). Secondary: `gh api repos/{owner}/{repo}/issues/N/sub_issues` if sub-issue API is available.

## Step 2 — Extract Refs from Body

From `body`, regex-extract THEN validate. Extraction is loose; **validation is strict** — drop anything that fails.

| Kind          | Extraction pattern                                       | Validation (required)                                | Example match         |
|---------------|----------------------------------------------------------|------------------------------------------------------|-----------------------|
| cited paths   | `` `path/to/file.ext` `` or bare `path/to/file.ext`      | match `^[A-Za-z0-9_./-]+$` ∧ ¬contains `..` segment ∧ ¬absolute (`^/`) — reject otherwise | `src/core/runner.ts`  |
| symbols       | CamelCase identifiers, `function_names`                  | match `^[A-Za-z_][A-Za-z0-9_]{0,63}$` — reject anything else (incl. flags, paths, error strings with quotes/spaces) | `WorktreeSetup`, `run_phase` |
| blocked-by Ns | `blocked by #(\d+)`, `blocks #(\d+)`, `parent: #(\d+)`, `closes #(\d+)` | digits only (regex already enforces); dedup; **cap at 20** (warn `dep-drift: capped at 20 blockers (body contained N)` if exceeded) | `#179` |

**Validation rationale:**
- Symbols flow into `grep` arguments — without the allowlist, a body-symbol like `-e '/etc/passwd'` or `$(id)` would inject as a grep flag or command substitution.
- Paths flow into `git log -- <paths>` — without the `..` ban + absolute-path ban, traversal patterns leak outside the repo.
- Blocker numbers flow into `gh issue view <N>` — the `\d+` regex enforces numeric, but the **dedup + cap** prevents an issue body with 200 `closes #N` references from triggering 200 sequential `gh` API calls.

Loose extraction (e.g. picking up an "error string" candidate) then strict validation = silently drop the candidate, do not abort.

∅ validated cited paths → git-drift falls back to entire repo (all commits since createdAt).
∅ validated symbols → symbol-drift is a no-op.
∅ validated blocked-by → dep-drift is a no-op.

## Step 3 — Drift Checks (parallel, deterministic)

Run all 3 checks concurrently. Each emits 0 or more signal entries.

### git-drift

```bash
created_at=$(gh issue view N --json createdAt --jq '.createdAt')
# If cited paths extracted:
git log --since="$created_at" --oneline -- path/to/cited/file.ext ... | wc -l
# If ∅ cited paths (fallback: whole repo):
git log --since="$created_at" --oneline | wc -l
```

Signal fires if count > 0.
`kind: "git-drift"` | `description: "N commits on cited paths since issue created"` | `evidence: [sha list]`

### symbol-drift

```bash
# $sym already validated in Step 2 to match ^[A-Za-z_][A-Za-z0-9_]{0,63}$
# Use grep -F (fixed-string) + -- end-of-options marker for defense-in-depth.
for sym in <validated_symbols>; do
  grep -rqF -- "$sym" --include='*.ts' --include='*.tsx' --include='*.js' \
       --include='*.py' --include='*.sh' --include='*.md' . \
    || echo "missing: $sym"
done
```

Signal fires per missing symbol.
`kind: "symbol-missing"` | `description: "symbol '$sym' not found in tree"` | `evidence: ["$sym"]`

### dep-drift

```bash
# $blocker already validated in Step 2 to be numeric, deduped, and capped at 20.
# Capture stderr explicitly to distinguish "issue is open" from "API error" —
# silently treating API errors as "not closed" would mask the dep-drift signal.
for blocker in <validated_blockers>; do
  if ! out=$(gh issue view "$blocker" --json state --jq '.state' 2>&1); then
    echo "dep-drift: error fetching #$blocker — skipped ($out)" >&2
    continue
  fi
  [ "$out" = "CLOSED" ] && echo "closed: #$blocker"
done
```

Signal fires per closed blocker. Semantics: closed blocker = signal regardless of meaning (could be "ready to proceed, re-verify scope" OR "this issue is now moot") — DP(A) surfaces the ambiguity; user decides.
API failures (auth, network, rate-limit, repo-not-found) are surfaced as warnings on stderr rather than silently swallowed — operators see "skipped" entries and can re-run if needed.
`kind: "dep-resolved"` | `description: "blocker #$blocker is now closed"` | `evidence: ["#$blocker"]`

## Step 4 — Decide

### S == ∅ (no signals)

- **Pipeline mode (M == pipeline):**
  Print exactly: `Issue still relevant.`
  Return silently. `/dev` proceeds to next step.

- **Standalone mode (M == standalone):**
  Print richer summary:
  ```
  Issue #N still relevant.
  Checks: git-drift (0 commits) | symbol-drift (all found) | dep-drift (no closed blockers)
  ```
  Exit 0.

### S ≠ ∅ (signals fired)

Render `## Drift Signals` block:

```
## Drift Signals — Issue #N

| Kind           | Description                          | Evidence             |
|----------------|--------------------------------------|----------------------|
| git-drift      | 12 commits on cited paths since...   | abc1234, def5678 ... |
| symbol-missing | symbol 'WorktreeSetup' not found     | WorktreeSetup        |
| dep-resolved   | blocker #179 is now closed           | #179                 |
```

Then present DP(A):

**Pipeline DP (4 options — M == pipeline ∧ ¬--update-iter=2):**

```
── Decision: Issue #N drift detected ──
Context:     <signal count> signal(s) fired (see ## Drift Signals above)
Target:      decide whether to continue, update, close, or abort
Path:        executed immediately after choice

Options:
  1. Proceed anyway        — continue, current premise accepted as-is
  2. Update issue first    — re-invoke /issue-triage, then re-run /recheck once
  3. Close as resolved/obsolete — gh issue close N --reason completed ; abort /dev
  4. Abort                 — exit /dev cleanly, no mutation
Recommended: Option 1 or 2 — depends on signal severity
```

**Pipeline DP on 2nd run (M == pipeline ∧ --update-iter=2):**
Same block, but Option 2 (Update issue first) is OMITTED. Forces terminal decision. No infinite loop.

**Standalone DP (3 options — M == standalone):**

```
── Decision: Issue #N drift detected ──
Context:     <signal count> signal(s) fired (see ## Drift Signals above)
Target:      decide whether to continue, close, or abort
Path:        executed immediately after choice

Options:
  1. Proceed    — continue with current premise
  2. Close as resolved/obsolete — gh issue close N --reason completed
  3. Abort      — exit cleanly, no mutation
Recommended: Option 1 or 3 — depends on signal severity
```

## DP Outcomes — Implementation

| Option               | Effect                                                                                    |
|----------------------|-------------------------------------------------------------------------------------------|
| **Proceed anyway**   | Return exit 0. In pipeline, `/dev` re-scans and continues to next step.                  |
| **Update issue first** | `Skill: "issue-triage", args: "N"` → then re-run self with `--from-dev --update-iter=2 #N`. On 2nd run, omit Update from DP (loop bound = 1 iteration). **Note on task state:** `/dev` has already marked its `triage` task `completed` in the prior Step 8 cycle and does not re-mark it during this in-skill re-invocation. The triage task remains `completed` in `/dev`'s task list — by design, since recheck owns the side-channel refinement, not `/dev`. The actual triage work is re-executed and its effects (label changes, re-classification) take hold immediately; only the task-list flag is stale, and that has no downstream consumer. |
| **Close as resolved/obsolete** | `gh issue close N --reason completed --comment "Closed by /recheck — drift signals indicated issue is no longer applicable."` → exit with abort signal so `/dev` marks task cancelled. |
| **Abort**            | Exit cleanly. No mutation. `/dev` halts cleanly.                                         |

## State

No on-disk artifact. `/dev` tracks recheck as Σ_s (session-only) like `validate`, `ci-watch`. Re-running `/dev #N` in a new session re-runs `/recheck` — acceptable: deterministic checks are cheap and fresh state is more valuable than skip-on-resume.

`RecheckResult` is ephemeral — built during execution, consumed by DP(A) prompt, then discarded:
- `issue_number: int`
- `signals: Signal[]` — empty on clean path; `Signal` = { `kind`, `description`, `evidence[]` }
- `blocking: bool` — `true` iff `signals` non-empty

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Chain Position

- **Phase:** Frame
- **Predecessor:** `/issue-triage`
- **Successor:** `/frame` (F-lite, F-full) ∨ `/implement` (S, frame skipped)
- **Class:** `adv` — `/dev`'s type system is single-valued per step (`gate ∈ {frame, spec, plan}`, all others `adv`). The DP rendered on signal-fire is **skill-internal**: `/recheck` self-manages the blocking decision the same way `/validate` and `/ci-watch` do when they surface failures. From `/dev`'s perspective, `/recheck` is always `adv`.

## Exit

| Path                              | Effect                                                                 |
|-----------------------------------|------------------------------------------------------------------------|
| Via `/dev` — clean                | Print `Issue still relevant.` → return silently → `/dev` continues     |
| Via `/dev` — Proceed on signals   | Return exit 0 → `/dev` re-scans → next step                           |
| Via `/dev` — Update issue first   | Invoke `issue-triage` → re-run self once (`--update-iter=2`)          |
| Via `/dev` — Close                | `gh issue close N` → exit with abort signal → `/dev` marks cancelled  |
| Via `/dev` — Abort                | Exit cleanly, no mutation → `/dev` halts                              |
| Standalone — clean                | Print richer summary (counts per check) → exit 0                      |
| Standalone — signal               | Render `## Drift Signals` + 3-option DP → apply outcome               |

## Edge Cases

- ∅ cited paths ∧ ∅ symbols ∧ ∅ blockers in body → git-drift uses entire repo since `createdAt` (commit count); symbol-drift + dep-drift are no-ops.
- Issue ¬∃ (gh 404) → print `Error: issue #N not found.` + exit 1.
- `--update-iter=2` on a clean 2nd run → print `Issue still relevant (re-verified after triage update).` + return.
- `createdAt` parse failure → fallback to `--since="1 year ago"` + warn: `Warning: could not parse issue creation date; using 1-year fallback.`

$ARGUMENTS
