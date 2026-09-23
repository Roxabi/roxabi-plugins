# Cookbook: Resolution

Let:
  ε := finding (contradiction, stale ref, redundancy, bloat, memory entry)
  μ := MEMORY.md (first κ lines injected every session)
  τ := memory/*.md (topic files, loaded on demand)
  α := .claude/agent-memory/*/MEMORY.md (per-agent)
  λ := .claude/context-audit-log.md (append-only audit log)
  Π := placement targets (auto-detected per project)

## Phase 3 — Present Resolution Plan

```
Context Audit Report
====================

Contradictions ({N}):
  1. {file_a}:{line} vs {file_b}:{line}
     "{rule_a}" contradicts "{rule_b}"
     Resolution: {Fix|Promote|Relocate|Delete} → {target}

Stale References ({N}):
  1. {file}:{line} — references `{path}` which no longer exists
     Resolution: Delete

Redundancies ({N}):
  1. {file_a}:{line} duplicates {file_b}:{line}
     Resolution: Delete from {file_b}

Bloat ({N}):
  1. {file} is {lines} lines (threshold: {limit})
     Resolution: Promote {section} → {target}

Memory Entries ({N}):
  ε                              | Source | Resolution | Target      | Recur
  CI --allowed-tools finding     | μ      | Promote    | CLAUDE.md   | 1st
  Worktree #389 path             | μ      | Delete     | —           | 1st
  API auth edge case             | α/be   | Relocate   | api/CLAUDE  | 2nd
  Epic #344 tracker (refs DONE)  | μ      | Promote    | CLAUDE.md   | 1st
  Sprint status #353 (refs DONE) | μ      | Delete     | —           | 1st

Score: {healthy | needs attention | bloated}
  Total findings:  {count}
  Contradictions:  {count}
  Stale:           {count}
  Redundant:       {count}
  Memory entries:  {count}
  Recurrences:     {count}
```

`--dry-run` → stop here.

→ present choice: **Execute all** | **1-by-1** (per-ε approve/change) | **Skip**

## Phase 4 — Execute

∀ approved ε, in order:
1. **Fix**: make the code/config change, ¬just delete
2. **Promote**: append to target (respect structure) — Promote moves content, see below
3. **Relocate**: append to scoped target — Relocate moves content, see below
4. **Delete**: nothing to carry over; the removal below is the whole action

**After each → run the backlink sweep, repoint every citation it finds, then delete ε from
source** (μ/τ/α/CLAUDE.md). Apply via Edit. Show exact diff before each change.

The sweep is bound to *that sentence*, ¬to the four labels. Every resolution ends in the
same removal, so binding the guard to the act covers all of them at once — including
**Fix**, which four label-by-label reminders missed: a Fix lands the root-cause change and
then drops the entry, dangling exactly the citations the other three were guarded against.

### Backlink sweep — the step before every removal, ¬a later pass

Removing a memory file leaves `[[wikilink]]` citations dangling in the **surviving** files, invisibly: nothing in the removed file records who pointed at it. Measured twice — a 15-file purge left 7 broken links across 11 files in 4 different stores; a later batch left 14 forward-references to sweep by hand.

**Why it runs before the removal, ¬after.** A `[[name]]` with no target file is legitimate here: it marks a topic ¬yet written. Once the target is gone, a link broken by the purge and a deliberate forward-reference have the same shape, and the next audit files the damage as "not written yet". Sweep first ∨ lose the mapping.

**Two scopes, two outcomes.** Citations cross projects, so the search covers every store —
but Safety rules 2 and 4 were written for project-local edits and still hold. In-project
citations are repointed under whichever mode the operator chose. Out-of-project citations
are **reported, and the pass stops**: *Execute all* is consent for this project, ¬a blanket
ask-gate removal for someone else's store.

```bash
# ∀ file about to be removed — whatever the resolution — BEFORE touching it
stem="${stem:?stem of the file being removed, e.g. project_gh_actions_quota}"
esc=$(printf '%s' "$stem" | sed 's/[][\.*^$+?(){}|/]/\\&/g')

# Derived from the wikilink grammar, ¬from the forms that came to mind:
#   [[ <path>/ ]] optional   stem   [.md] optional   then exactly one terminator
# Terminator ∈ { ]  #  |  \| } — `\|` is the alias pipe escaped inside a markdown
# table, which is where citations most often sit. The `.md` suffix and the path
# prefix are both legal targets of the same link and are written in the wild.
# `m` is in no terminator set, so `[[stemmier]]` still does ¬match.
link='\[\[([^]|#]*/)?'"$esc"'(\.md)?(\]|#|\\?\|)'

# every memory area: τ across ALL stores (citations cross projects) + α + CLAUDE.md
. "${CLAUDE_SKILL_DIR:?CLAUDE_SKILL_DIR unset — cannot locate memory-store.sh}/memory-store.sh"
own=$(cd "$(claude_resolve_memory_dir)" 2>/dev/null && pwd -P) || own=''
areas="${areas:-$(
  ls -d "$HOME"/.claude/projects/*/memory 2>/dev/null
  ls -d .claude/agent-memory/*/ 2>/dev/null
  printf '.\n'
)}"

# Overlapping roots double-count: `.` already contains .claude/agent-memory, so every
# α citation reached through both prints twice and gets repointed twice. Canonicalise,
# sort (a parent sorts before its children), drop every root nested in one already kept.
roots=()
while IFS= read -r a; do
  [ -n "$a" ] && [ -d "$a" ] || continue
  p=$(cd "$a" && pwd -P) || continue
  roots+=("$p")
done <<< "$areas"
[ ${#roots[@]} -eq 0 ] && { echo "no readable memory area in scope" >&2; exit 2; }
mapfile -t roots < <(printf '%s\n' "${roots[@]}" | sort -u)

here=$(pwd -P)
mine=(); theirs=()
for p in "${roots[@]}"; do
  nested=0
  for q in "${mine[@]}" "${theirs[@]}"; do
    case "$p/" in "$q"/*) nested=1; break ;; esac
  done
  [ "$nested" -eq 1 ] && continue
  in_project=0
  [ -n "$own" ] && [ "$p" = "$own" ] && in_project=1
  case "$p/" in "$here"/*) in_project=1 ;; esac
  [ "$in_project" -eq 1 ] && mine+=("$p") || theirs+=("$p")
done

# Tri-state, ¬`|| echo "safe"`. grep exits 0 = found, 1 = none, ≥2 = it could not look.
# `2>/dev/null || echo 'dangles nothing'` maps the third case onto the second and tells
# the operator the removal is safe *because the check failed*. stderr stays attached.
echo "── IN-PROJECT — repoint these under the chosen mode ──"
if [ ${#mine[@]} -eq 0 ]; then
  echo "  (no in-project area in scope)"
else
  grep -rnE --include='*.md' "$link" -- "${mine[@]}"; rc=$?
  case $rc in
    0) ;;
    1) echo "  no citations of [[$stem]] here — removal dangles nothing in this project" ;;
    *) echo "  SWEEP FAILED (grep exit $rc) — citation status UNKNOWN, ¬safe. Do not remove $stem." >&2
       exit "$rc" ;;
  esac
fi

echo "── OUT-OF-PROJECT — reported only, ¬edited by this pass ──"
if [ ${#theirs[@]} -eq 0 ]; then
  echo "  (no other store in scope)"
else
  grep -rnE --include='*.md' "$link" -- "${theirs[@]}"; rc=$?
  case $rc in
    0) echo "  STOP: those citations live outside this project (Safety 2 + 4). Approve that"
       echo "        batch separately — Execute all does ¬cover it."
       exit 3 ;;
    1) echo "  no citations of [[$stem]] in other stores" ;;
    *) echo "  SWEEP FAILED (grep exit $rc) — citation status UNKNOWN, ¬safe. Do not remove $stem." >&2
       exit "$rc" ;;
  esac
fi
```

**Repoint, ¬delete the citation.** Point it at the replacement, or at where the knowledge went (`CLAUDE.md:54`, `docs/positioning.md`, a Π target, a SHA), keeping the carrying sentence. An erased link loses the context the sentence was making; a repointed one keeps it.

**Promote and Relocate dangle too — differently.** They move the *content*, so:

- the file may survive while the cited **heading** leaves it: `[[stem#heading]]` still resolves to the file and silently lands nowhere. After moving a section, re-grep `\[\[${esc}#` and repoint each anchor at the new home.
- if the file is emptied and removed after the move, it is the Delete case — same sweep, same pass.

Sweep output with unfixed citations, a `SWEEP FAILED`, or a `STOP` → the ε is ¬resolved. Phase 5 counts it as open.

## Phase 5 — Log + Report

Append to λ (create if ¬∃):

```markdown
## Audit <YYYY-MM-DD>

| ε | Source | Resolution | Target | Recurrence |
|---|--------|-----------|--------|------------|
| ... | ... | ... | ... | Nth |

Summary: <N> fixed, <N> promoted, <N> relocated, <N> deleted
Recurrences: <N> (details)
```

Final report:
```
Context Cleanup Complete
========================
  Before: {N} findings
  After:  {N} remaining
  ─────────────────────
  Fixed:     {N} (code/config changes made)
  Promoted:  {N} (→ permanent docs)
  Relocated: {N} (→ scoped targets)
  Deleted:   {N} (ephemeral/stale/redundant)
  ─────────────────────
  Recurrences: {N} (fix didn't stick)
  Systemic:    {N} (3rd+ occurrence)

Files modified:
  {file_a} — {description}
  {file_b} — {description}
```

Commit after all fixes applied.
