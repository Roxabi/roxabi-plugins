# Cookbook: Analysis

Let:
  ε := finding (contradiction, stale ref, redundancy, bloat, memory entry)
  μ := MEMORY.md (first κ lines injected every session)
  τ := memory/*.md (topic files, loaded on demand)
  α := .claude/agent-memory/*/MEMORY.md (per-agent)
  κ := 200 (MEMORY.md line cap)
  Π := placement targets (auto-detected per project)

## Phase 2 — Analyze for Findings

Read each file. Build ε set:

### 2a. Contradictions
Two semantically conflicting rules (e.g., "use semicolons" vs "no semicolons", snake_case vs camelCase, "run tests first" vs "skip tests").
Detection: read all rules → build directive list → pairwise conflict check.

### 2b. Staleness
Rules referencing: ¬∃ files/paths (`Glob` to verify) | ¬installed deps (`grep package.json`) | deprecated tools/patterns | completed TODOs listed pending | issue #N / PR refs / branch names / worktree paths (ephemeral).

```bash
test -f "<path from ε>" && echo "EXISTS" || echo "STALE"
grep -rl "<key phrase>" CLAUDE.md $(find . -maxdepth 3 -name "CLAUDE.md") .claude/agents/*.md 2>/dev/null
```

### 2c. Redundancy
Same rule in multiple files (exact/near-dup) | overlapping trigger phrases | memory entries duplicating CLAUDE.md | content already in Π targets.

### 2d. Bloat
CLAUDE.md > 500 lines | memory > κ lines | > 10 skills | overly specific rules.

### 2e. Tempfile Hygiene

SKILL.md files writing fixed `/tmp/<name>` paths → collision risk across parallel runs / branches. Enforces `${CLAUDE_PLUGIN_ROOT}/../shared/references/tempfile-convention.md` (bidirectional: if you rename the convention doc, update this reference and the pointer inside the doc's **Enforced by** section).

**Broad pattern (catches any `/tmp/<name>` regardless of extension or lack thereof):**

```bash
grep -rnE '/tmp/[a-z0-9_-]{4,}' plugins/*/skills/**/SKILL.md 2>/dev/null \
  | grep -v -E 'mktemp|XXXXX'
```

Hits → Resolution: **Fix** (migrate to `mktemp -d -t <plugin>-<purpose>-<scope>-XXXXXX` + `trap 'rm -rf "$TMPDIR"' EXIT`, files as `$TMPDIR/<name>`).

**Stale-tempfile sweep** — orphaned `/tmp/<plugin>-*` older than 24h (SIGKILL / crash survivors):

```bash
find /tmp -maxdepth 1 -name 'dev-core-*' -o -name 'web-intel-*' -o -name 'cv-*' \
  -o -name 'linkedin-apply-*' -o -name 'content-lab-*' 2>/dev/null \
  | xargs -r stat -c '%Y %n' \
  | awk -v cutoff=$(($(date +%s) - 86400)) '$1 < cutoff {print $2}'
```

Report paths, ask user before `rm -rf`.

Exempt: tests under `tests/` / `__tests__/` (fixtures may hardcode paths intentionally).

### 2f. Memory Entries (μ + τ + α)

∀ entry, classify:

| Signal | Resolution |
|--------|-----------|
| Bug/workaround | **Fix** (root cause) |
| Cross-cutting insight ¬in permanent docs | **Promote** (→ Π) |
| Agent/domain-specific in global memory | **Relocate** (→ scoped target) |
| All tracked refs CLOSED/MERGED | **Promote** the durable lesson (→ Π) if the body holds one — only then **Delete**. Candidate, ¬an auto-delete |
| Any tracked ref OPEN ∨ unresolvable | **Keep** (still live ∨ state unproven) |
| References ¬∃ file/workflow/worktree path ∨ a deleted branch | **Delete** (stale) |
| Already in Π targets | **Delete** (redundant) |

#### Ref-state sweep (`project`-type entries)

An entry narrating issue/epic state rots in 2–4 weeks. Closing its refs makes it stale **as a status tracker** — it does ¬make it worthless. The body may carry the one durable sentence the audit exists to preserve (e.g. "this repo is trunk-mode since #376" survives #376 closing).

**The ordering is the finding, ¬the sweep.** ∀ candidate, in this order:

1. Does the body hold a durable lesson — invariant, trap, decision rationale — that outlives the refs? → **Promote** (→ Π), then delete the entry.
2. Only a "no" reaches **Delete**.

`all refs CLOSED → Delete` is wrong as a rule: it destroys knowledge whose only defect is that its tracker finished.

**Cost, before you start.** One `gh` round-trip per *unique* ref — the block prints the
count and the expected wall-clock before the first call, so a 200-ref store announces
itself instead of stalling. `CLEANUP_CONTEXT_SKIP_GH=1` skips the network entirely and
degrades to the same WARN path as an absent `gh`: every ref UNRESOLVED, every entry KEEP.

```bash
# Resolve every #NNNN cited by project-type entries. One gh call per UNIQUE ref
# across all entries, ¬one per entry.
. "${CLAUDE_SKILL_DIR:?CLAUDE_SKILL_DIR unset — cannot locate memory-store.sh}/memory-store.sh"
memory_dir="$(claude_resolve_memory_dir)"

tmp=$(mktemp -d -t dev-core-cleanup-context-refstate-XXXXXX)
trap 'rm -rf "$tmp"' EXIT

shopt -s nullglob
md=("$memory_dir"/*.md)
shopt -u nullglob
[ ${#md[@]} -eq 0 ] && { echo "no memory entries under $memory_dir"; exit 0; }

# The entry list is carried NUL-delimited and never word-split. Unquoted, a memory
# filename holding whitespace splits into two words: the entry is dropped and the
# classifier is pointed at whatever those words happen to name in the repo tree.
grep -lZE '^ +type: project$' -- "${md[@]}" > "$tmp/entries"; rc=$?
[ "$rc" -le 1 ] || { echo "ABORT: cannot scan $memory_dir (grep exit $rc)" >&2; exit "$rc"; }
mapfile -d '' -t entries < "$tmp/entries"
[ ${#entries[@]} -eq 0 ] && { echo "no project-type entries under $memory_dir"; exit 0; }

# …and what the loop iterates must still be inside the store.
for f in "${entries[@]}"; do
  case "$f" in
    "$memory_dir"/*) ;;
    *) echo "ABORT: $f is outside $memory_dir" >&2; exit 2 ;;
  esac
done

# Refs are identifiers, ¬quantities: dedupe as strings. `sort -un` compares them
# numerically, folds `#0344` into `#344`, and prints whichever it kept — silently
# re-labelling one ref as another and judging the entry on a ref it never cited.
mapfile -t refs < <(grep -ohE '#[0-9]+' -- "${entries[@]}" | tr -d '#' | sort -u)

echo "ref-state sweep: ${#refs[@]} unique refs → ${#refs[@]} gh calls, ≈${#refs[@]}s (≈1s each)"
echo "  set CLEANUP_CONTEXT_SKIP_GH=1 to skip the network — same WARN path as an absent gh"

gh_ok=1
if [ -n "${CLEANUP_CONTEXT_SKIP_GH:-}" ]; then
  gh_ok=0
  echo "WARN: CLEANUP_CONTEXT_SKIP_GH set — every ref reads UNRESOLVED, every entry stays KEEP"
elif ! command -v gh >/dev/null || ! gh auth status >/dev/null 2>&1; then
  gh_ok=0
  echo "WARN: gh absent/unauthenticated — every ref reads UNRESOLVED, every entry stays KEEP"
fi

for n in "${refs[@]}"; do
  # `gh issue view` answers for PRs too on current gh (MERGED/CLOSED)
  state=''
  [ "$gh_ok" -eq 1 ] && { state=$(gh issue view "$n" --json state -q .state 2>/dev/null) || state=''; }
  case "$state" in
    CLOSED|MERGED) echo "$n DONE" ;;
    OPEN)          echo "$n OPEN" ;;
    *)             echo "$n UNRESOLVED" ;;
  esac
done | tee "$tmp/state"   # printed, ¬only cached: the operator must see UNRESOLVED

for f in "${entries[@]}"; do
  mapfile -t cited < <(grep -ohE '#[0-9]+' -- "$f" | tr -d '#' | sort -u)
  [ ${#cited[@]} -eq 0 ] && { echo "KEEP      $(basename "$f") — no refs, ¬a status tracker"; continue; }
  live=0
  for n in "${cited[@]}"; do grep -qx "$n DONE" "$tmp/state" || live=1; done   # ¬DONE ⇒ live
  [ "$live" -eq 1 ] \
    && echo "KEEP      $(basename "$f") — refs ${cited[*]}" \
    || echo "CANDIDATE $(basename "$f") — all DONE (${cited[*]}) → ask Promote before Delete"
done
```

**Fail toward keeping.** A ref that does ¬answer is ¬a closed ref — and a ref that answers
is ¬necessarily answering about the thing the entry cited:

| Ref state | Cause | Reads as |
|-----------|-------|----------|
| `CLOSED` / `MERGED` | finished | DONE |
| `OPEN` | live | OPEN → keep |
| no answer | `gh` absent ∨ unauthenticated ∨ rate-limited; the number exists in no repo the local `gh` can reach | **OPEN** → keep — fail-safe |
| resolves, but to a different thing | the ref belongs to **another** repo and `gh` resolved `#NNNN` against *this* repo's default, answering about an unrelated issue that happens to carry that number; `#NNNN` is ¬a ref at all — heading anchor, CSS colour (`#336699`), ordinal ("step #3") that collides with a real issue | whatever *that* thing's state is — possibly **DONE**. ¬fail-safe: the ref list the block prints is the check |

Reading "unknown" as "closed" flags the **whole** memory as a delete candidate the day a token expires. The sweep must degrade to keeping everything, visibly (the `WARN` line above), ¬to proposing a purge.

The second row is the inverse false positive, and no exit code exposes it: `gh` succeeded. A cross-repo `#12` and an ordinal `#3` both resolve here, to a closed local issue, and push the entry to CANDIDATE. Nothing downstream can tell — which is why the block prints the ref list it judged on for the operator to read, and why CANDIDATE is a proposal for Phase 3, never an action.
