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
1. **Fix**: make code/config change, ¬just delete
2. **Promote**: run the backlink sweep, append to target (respect structure) — Promote moves content, see below
3. **Relocate**: run the backlink sweep, append to scoped target — Relocate moves content, see below
4. **Delete**: run the backlink sweep **first**, repoint every citation it finds, then remove from source

After each → delete ε from source (μ/τ/α/CLAUDE.md). Apply via Edit. Show exact diff before each change.

### Backlink sweep — sub-step of Delete/Promote/Relocate, ¬a later pass

Removing a memory file leaves `[[wikilink]]` citations dangling in the **surviving** files, invisibly: nothing in the removed file records who pointed at it. Measured twice — a 15-file purge left 7 broken links across 11 files in 4 different stores; a later batch left 14 forward-references to sweep by hand.

**Why it runs before the removal, ¬after.** A `[[name]]` with no target file is legitimate here: it marks a topic ¬yet written. Once the target is gone, a link broken by the purge and a deliberate forward-reference have the same shape, and the next audit files the damage as "not written yet". Sweep first ∨ lose the mapping.

```bash
# ∀ file about to be deleted/promoted/relocated, BEFORE touching it
stem="${stem:?stem of the file being removed, e.g. project_gh_actions_quota}"
esc=$(printf '%s' "$stem" | sed 's/[][\.*^$+?(){}|/]/\\&/g')

# every memory area: τ across ALL stores (citations cross projects) + α + CLAUDE.md
areas="${areas:-$(ls -d "$HOME"/.claude/projects/*/memory 2>/dev/null) $(ls -d .claude/agent-memory/*/ 2>/dev/null) .}"

# [[stem]] | [[stem|alias]] | [[stem#heading]] — char after the stem ∈ { ] , | , # },
# so [[stemmier]] does ¬match
grep -rnE --include='*.md' "\[\[${esc}([]|#])" $areas 2>/dev/null \
  || echo "no citations of [[$stem]] — removal dangles nothing"
```

**Repoint, ¬delete the citation.** Point it at the replacement, or at where the knowledge went (`CLAUDE.md:54`, `docs/positioning.md`, a Π target, a SHA), keeping the carrying sentence. An erased link loses the context the sentence was making; a repointed one keeps it.

**Promote and Relocate dangle too — differently.** They move the *content*, so:

- the file may survive while the cited **heading** leaves it: `[[stem#heading]]` still resolves to the file and silently lands nowhere. After moving a section, re-grep `\[\[${esc}#` and repoint each anchor at the new home.
- if the file is emptied and removed after the move, it is the Delete case — same sweep, same pass.

Sweep output with unfixed citations → the ε is ¬resolved. Phase 5 counts it as open.

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
