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
| References #N, PR, branch, worktree | **Delete** (ephemeral) |
| References ¬∃ file/workflow | **Delete** (stale) |
| Already in Π targets | **Delete** (redundant) |
