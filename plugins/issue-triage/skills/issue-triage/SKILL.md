---
name: issue-triage
argument-hint: '[list | set <num> | create --title "..." [--parent N] [--size S] [--priority P] [--type T] [--lane L]]'
description: >-
  Triage/create GitHub issues — set size/priority/lane/type labels, manage dependencies & parent/child. Run before `/feature` picks an issue up. Triggers: "triage" | "create issue" | "set size" | "set priority" | "blocked by" | "set parent" | "child of" | "sub-issue" | "file an issue" | "log a bug" | "open an issue" | "file a bug" | "add issue" | "new issue" | "set lane" | "set type".
version: 0.6.6
allowed-tools: Bash, Read, ToolSearch
---

# Issue Triage

Let: T := `bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts` — triage CLI | κ := complexity score

Default: `T` or `T list` (no args = list).

Create GitHub issues, assign Size/Priority labels, manage blockedBy dependencies and parent/child relationships.

Use this standalone skill for issue creation, labels and native relations. A
`Blocked by:` line in a body is not a native relation. The project contract is
`docs/agents/issue-tracker.md`. Omp-build automated issue body, label, relation
and state writes go through UW; humans may also change issues directly. Neither
an edit nor a native close alone accepts a Spec or establishes UW completion.

## Public-safe publication

Before any GitHub write, review the final title, body and comment text for meaning. Omit secret values, client data, raw logs and private operational inventory; use a minimal sanitized reproduction. Security-report details go to the project's private disclosure channel, not a public issue. This is the submitting agent's review, not an extra human approval for every issue.

A trusted existing scanner can add a best-effort check with updates and provider verification disabled. Inspect results privately and do not publish a finding. A clean exit does not prove complete coverage or confidentiality: format detection can skip text, and private prose, attachments and links still need review. This guidance adds no automatic scanner gate, native adapter, setup command or writer.

## Instructions

1. List all open issues: `T` / `T list` | List untriaged only: `T list --untriaged`
2. ∀ issue: determine Size, κ (see [Complexity Scoring](#complexity-scoring)) and Priority (see [Priority Guidelines](#priority-guidelines))
3. Set values: `T set <number> --size <S> --priority <P>`
4. Create issues: `T create --title "Title" [--body "Body"] [--label "bug,frontend"] [--size M] [--priority High] [--type feat] [--lane b] [--parent 163]`
5. Adopt a repository: `T init [--dry-run] [--repo owner/repo] [--root path]`. Preview by default (printing the plan is not approval). Writes require `--approve '<digest>' --operator-approval '<operator reply>'` from a prior preview. `--root` selects the checkout whose `docs/agents/issue-tracker.md` is read or written when trusted triage starts elsewhere; it does not change the GitHub repository. A symlink on that path is followed only when its resolved target remains inside the selected checkout; an escaping link or non-directory ancestor is refused before any write. Without it, init uses the current checkout. The contract is written only when absent and only at the selected checkout’s git toplevel. An existing contract is authoritative: init prints `contract: keep-existing` and never rewrites it. Labels come from its `Label | Colour` table (a leading pipe is optional), or from canonical names in the template list; `bug` and other non-canonical snapshot entries are not a vocabulary. `epic` and `reviewed` are created only when that vocabulary lists them. An existing label is never recoloured, and a case mismatch is reported instead of created. `--dry-run` also prints one org issue type line: `missing org issue types (N): …` names the canonical types the org lacks — an org type that is disabled counts as lacking, because only **enabled** org types can be set on an issue; `missing org issue types: (none)` when every canonical type is enabled; `org issue types: unavailable (…)` when the org lookup fails. It is a report only: it writes nothing, never refuses label adoption, and init never creates org issue types.
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

The project contract (`docs/agents/issue-tracker.md`) binds this rubric to the repository (which parent is the milestone, what counts as shipped) and wins where it differs.

| Priority | When | Action |
|----------|------|--------|
| **Urgent** (P0) | Blocking now: the default branch or a release is blocked, or a security incident is live | Do immediately |
| **High** (P1) | The milestone in progress, or a shipped check that lies (see below) | Do this sprint |
| **Medium** (P2) | A real defect or debt that does not lie: a check that refuses too much or names the wrong cause, a misleading doc, a correctness gap outside the milestone | Plan for next sprint |
| **Low** (P3) | Backlog: test hardening, deferred non-blocking findings, slices of a parked parent | Backlog |

P1 has two independent triggers; either one is enough:

1. **Milestone.** The open milestone parent needs the issue to close or to keep its promise. Being its child is not enough: a deferred non-blocking finding under it stays P2 or P3.
2. **A shipped check that lies.** A gate, guard, verifier or success predicate in shipped code reports a pass when it should fail or stop: a wrong-green gate, a fail-open verifier, a guard that no longer halts. This holds whatever the milestone. A check that fails closed (it refuses too much, or names the wrong cause) is P2.

A parent caps its feature slices, not its defects: a feature child sits at or below its parent, and a child that matches trigger 2 is P1 under any parent.

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
| `--type <T>` | Set org issueType on creation (additive). Valid: `fix`, `feat`, `docs`, `test`, `chore`, `ci`, `perf`, `epic`, `research`, `refactor`. A name outside this list exits 1 with no network call. A type the **org** has no **enabled** match for (missing or disabled in the org, or an unreachable org) also exits 1, **before** the issue is created — no issue, label, relation or body is written |
| `--parent <REF>` | Set parent issue on creation. REF = `#N` or `owner/repo#N` |
| `--add-child <REF>[,<REF>...]` | Add existing issues as children |
| `--blocked-by <REF>[,<REF>...]` | Set blocked-by on creation |
| `--blocks <REF>[,<REF>...]` | Set blocking on creation |

`create` prints `Created #N` first, then one line per write (`Type=`, `Size=`, `Parent=`, `BlockedBy=`…). A nonzero exit after `Created #N` leaves #N filed but incomplete: never create it again. Relation flags print one line per reference, so some references of one flag may already be applied. Read #N, then run `T set N` with only the missing effects; `set` does not accept `--status`.

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

**Resolution order** (`detectGitHubRepo`): (1) `github_repo` in dev-core config ∨ `GITHUB_REPO` env var (validated as `owner/repo`) → (2) fallback `git remote get-url origin` of the cwd. When filing from an untrusted checkout, start the trusted CLI in its own directory with `--no-env-file` and pass the target as `GITHUB_REPO` (the operator's value when set, otherwise the checkout's `gh repo view`); do not read the checkout's `.dev/dev-core.yml` pin. Bun reads `bunfig.toml` and `.env` from its startup directory, so a checkout-controlled preload could otherwise run before triage.

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
the issue, so an issue created without a `size:` label silently downgrades its own
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
  --title "Improve CI pipeline" \
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
