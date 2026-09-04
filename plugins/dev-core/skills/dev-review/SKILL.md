---
name: R-dev-review
argument-hint: [#PR]
description: >-
  Multi-domain code review (agents + Conventional Comments → findings + verdict).
  Triggers: "dev-review" | "code review" | "review changes" | "review PR #42" | "check my code" | "review my changes" | "review this PR" | "do a code review" | "review the diff" | "look at my code" | "/R-dev-review".
  Not the host natives /review or /doctor.
version: 0.5.0
allowed-tools: Bash, Read, Write, Glob, Grep, Task, Skill, ToolSearch
---

# Code Review

## Success

I := F collected ∧ verdict posted (PR ∃) ∧ Phase 8 decision made
V := `gh pr view {N} --comments | grep "## Code Review"` ∧ verdict ∈ {Approve, Request changes}

Review branch/PR via fresh domain-specific agents → Conventional Comments → findings + verdict.

**⚠ Flow: single continuous pipeline (Phases 1→4 + 6 + 8). ¬stop between phases. Decision response → immediately execute next phase. Stop only on: |Δ|=0, explicit Cancel, roster oracle review_halt, or Phase 8 completion.**

```
/R-dev-review          → diff origin/${BASE}...HEAD  (BASE = staging|main|master, first that exists)
/R-dev-review #42      → gh pr diff 42
```

Let:
  F := set of all findings | f ∈ F := single finding
  C(f) ∈ [0,100] ∩ ℤ — confidence | cat(f) ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
  Δ := changed files | BASE := staging ∨ main
  τ := tier (S | F-lite | F-full)
  Q := present choice, wait for user reply

## Pipeline

| Phase | ID | Required | Verifies via | Notes |
|-------|----|----------|---------------|-------|
| 1 | gather-changes | ✓ | Δ listed | — |
| 1.5 | secret-scan | ✓ | ∅ matches (or ACK) | — |
| 2 | spec-compliance | — | criteria checked | spec ∃ |
| 3 | multi-domain-review | ✓ | agents return | parallel · roster oracle |
| 4 | merge-and-present | ✓ | F + verdict | dedup → classify → keep/drop → verdict |
| 6 | post-to-pr | — | comment posted | PR ∃ |
| 8 | next-step | ✓ | decision made | — |

## Pre-flight

Success: F collected ∧ verdict posted ∧ Phase 8 decision made
Evidence: `gh pr view {N} --comments | grep "## Code Review"`
Steps: gather-changes → secret-scan → multi-domain-review → merge-and-present → post-to-pr → next-step
¬clear → STOP + ask: "Which branch/PR to review?"

## Phase 1 — Gather Changes

0. `BASE=$(. "${CLAUDE_SKILL_DIR}/../shared/lib.sh" && detect_base_branch)`
1. PR# → `gh pr diff <#>` | else → `git diff origin/${BASE}...HEAD`
2. Δ = `git diff --name-only origin/${BASE}...HEAD` (or `gh pr diff <#> --name-only`)
3. ∀ f ∈ Δ: read full (skip binaries, note)
4. |Δ| = 0 → halt
5. |Δ| > 50 → warn, suggest split

## Phase 1.5 — Secret Scan

```bash
git diff origin/${BASE}...HEAD | grep -iE '(password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[:=]\s*["\x27`][^"\x27`]{8,}' | head -20
```

∃ matches → WARN (redact to first 2 + last 2 chars):
```
⚠️  Potential secrets found in diff — review before proceeding:
  <file>: <matched line with secret value redacted to first 2 + last 2 chars>
```
→ present choice **Review and proceed** | **Abort**
∅ → continue silently.

## Phase 2 — Spec Compliance

**Resolve issue + spec (deterministic — #419):**

1. **issue_num** — priority:
   - `/R-dev-review #PR` → `gh pr view PR --json body,headRefName` → `(Fixes|Closes|Resolves) #(\d+)` in body; else first `N` from `feat/{N}-*` in `headRefName`
   - else current branch → `feat/{N}-*` match; else first `\d+` run (warn: legacy branch fallback)
2. **spec** ← lexicographically first `artifacts/specs/{issue_num}-*.md(x)` when issue_num set
3. **Approved σ only** — read frontmatter; `status: draft` → treat as spec ∄ for claim spawn (warn once); path-only roster
4. spec ∃ ∧ approved → ∀ criterion: met → ∅ | ¬met → `issue(blocking):` | ∀ met → `praise:`
5. spec ∄ → skip (steps 4–5 unchanged when no spec)
6. SC→Test matrix (τ≠S): matrix ∃ in PR body → verify no silent gaps (every SC has a row), NO TEST reasons ∈ `{infra-not-wired, prompt-logic-only, ui-manual-only, out-of-scope}` enum. ¬matrix ∧ τ≠S → `issue(blocking):` missing SC→Test matrix.

## Phase 3 — Multi-Domain Review (Fresh Agents)

Spawn fresh agents via Task (¬implementation context → ¬bias).

### Chunking (Slice 2 — O2)

Before dispatching agents, partition Δ into chunks using the Python chunker
(`${CLAUDE_SKILL_DIR}/chunker.py`).

```python
# Pseudo-code — orchestrator executes this logic inline
from chunker import parse_diff, chunk, compute_budget
from digest import emit_all_digests, format_digest_for_agent

raw_diff   = <diff text from Phase 1>
ctx_window = <active model context window, e.g. 200_000>

files   = parse_diff(raw_diff)
budget  = compute_budget(ctx_window)          # 0.4 × ctx_window
chunks  = chunk(files, budget)                # list[Chunk]
digests = emit_all_digests(chunks)            # list[BoundaryDigest]
```

- If `len(chunks) == 1` → single-chunk path (identical to pre-Slice-2 behaviour; all agents receive the full diff as before).
- If `len(chunks) > 1` → per-chunk Lane A dispatch (see below).

### Roster oracle

SOLE spawn decision for Phase 3. τ ← spec/plan frontmatter ∨ issue labels (default F-lite if unknown). `CHUNKS := |chunks|` from the chunker.

**Global vs per-chunk.** One global call (full Δ) for review-wide fields: `claims`, `priced_claim_ok`, `recall_eligible`, `verifier_enabled`, `verify_below_confidence`, `warnings`. Per-chunk `roster.sh --diff-list <chunk_i.files> …` supplies that chunk's `agents[]` for Lane A. Single-chunk: one call (Δ = the chunk) covers both. `R-adversarial` is the floor in every chunk. `max_agents` is a **per-chunk** cap.

**Spawn exactly `agents[]` from the (chunk) JSON — the table below is documentation of the oracle's gates, ¬an independent decision surface.** `gates[]` carries the per-agent reason; `capped[]` names agents dropped by `max_agents`. `R-recall` and `R-finding-verifier` are ¬in `agents[]` (separate phases: `recall_eligible` / `verifier_enabled`). `R-product-lead` ¬∈ review roster — Phase 2 owns spec compliance.

```bash
# spec_path from Phase 2; write Δ paths to a mktemp file (see tempfile-convention.md)
REVIEW_TMP=$(mktemp -d -t "dev-core-review-delta-419-XXXXXX")
trap 'rm -rf "$REVIEW_TMP"' EXIT
printf '%s\n' "${DELTA_FILES[@]}" > "$REVIEW_TMP/delta.txt"
bash ${CLAUDE_PLUGIN_ROOT}/skills/dev-review/roster.sh \
  --diff-list "$REVIEW_TMP/delta.txt" \
  --tier "$TIER" \
  --chunks "$CHUNKS" \
  [--spec "$spec_path"] \
  [--oracle-ok true|false] \
  --json
# per-chunk Lane A (skip when |chunks|=1 — the call above is the chunk)
printf '%s\n' "${CHUNK_I_FILES[@]}" > "$REVIEW_TMP/chunk_${i}.txt"
bash ${CLAUDE_PLUGIN_ROOT}/skills/dev-review/roster.sh \
  --diff-list "$REVIEW_TMP/chunk_${i}.txt" \
  --tier "$TIER" \
  --chunks "$CHUNKS" \
  [--spec "$spec_path"] \
  [--oracle-ok true|false] \
  --json
```

After every invocation: `∀ w ∈ warnings[] → echo into the review output (¬silent)`; `review_halt: true → HALT` with the warning text.

**R-tester gate (two-step):** first call ¬`--oracle-ok`. `delta_test_hit=true` in the JSON → run `bash ${CLAUDE_PLUGIN_ROOT}/skills/pr/run-falsify.sh --verify artifacts/reviews/{N}-falsify.json`, re-invoke `roster.sh` with `--oracle-ok true|false`. `delta_test_hit=false` → single call, R-tester ¬spawns. `delta_test_hit ∧ oracle_ok=missing → R-tester ¬spawns by design; the warning MUST appear in the output so the coverage gap is stated, ¬hidden`.

Exit: `0` ok · `1` usage/IO error (incl. unreadable `--spec`) · `2` σ priced-fence hygiene (σ has ≥1 priced fence ∧ ¬priced_claim_ok → spec-hygiene warning, emit `issue(blocking):` about the σ; ¬spawn R-security-auditor; JSON still printed on stdout).

`claims` + `priced_claim_ok` are reported for the σ-hygiene finding only; they ¬gate any spawn.

### Agent dispatch

| Agent | When | Focus |
|-------|------|-------|
| **R-adversarial** | **always** | red-team: bypass, fleet-regression, vacuous guards, assumption-kill + **OWASP lens** (secrets, injection, auth). R-security-auditor is independent when Δ ∩ auth/secrets/crypto (both may run) |
| **R-security-auditor** | **`path_hit`** only — token+stem (path segments, ¬`\bauth\b`); covers oauth/session/jwt/login/password/rbac + `**/auth/**` | OWASP, secrets, injection, auth |
| **R-tester** | `delta_test_hit ∧ oracle_ok=false` | coverage, AAA, edge cases, tautology |
| **R-axial-adr-review** | ∃ axial ADR (`axial: true` ∈ `docs/architecture/adr/`) ∧ Δ ∩ {`infrastructure/`, `adapters/`, `domains/`, `stages/`} ≠ ∅ | Drift along non-primary axis (target × concern duplication) — read-only review agent (no Write/Edit/Bash tools) |
| **R-frontend-dev** | `{frontend.path}` ∨ `{shared.ui}` non-empty → Δ ∩ those prefixes ≠ ∅; both empty → Δ ∩ {`.tsx`, `.jsx`, `.vue`, `.svelte`, `.css`, `.scss`} ≠ ∅ | FE patterns, components, hooks |
| **R-backend-dev** | `{backend.path}` non-empty ∧ Δ ∩ that prefix ≠ ∅; empty → ¬spawn | BE patterns, API, errors |
| **R-devops** | `τ=F-full ∧ Δ ∩ {scripts/, .github/, lefthook.yml, wrangler, deploy, Dockerfile} ≠ ∅` | config, deploy, infra — **the single infra agent** |
| **R-architect** | `τ=F-full ∧ Δ ∩ infra = ∅` — mutually exclusive with R-devops | patterns, structure, circular deps |
| **R-recall** | Phase 3b: `|chunks|>1 ∧ |Δ| > recall_min_delta` ∧ canonical class ∧ ≥3 callsites. Skip on single-chunk | class-join, uncited callsites — ¬Lane A |

`max_agents` (default 4) is a **per-chunk** cap on `agents[]` (excl. R-recall / R-finding-verifier); truncated names land in `capped[]`.

> **Note on R-axial-adr-review asymmetry (intentional):** The `/R-dev-review` condition is **structural** — it triggers when the diff touches `infrastructure/`, `adapters/`, `domains/`, or `stages/`. The spec phase (`/R-spec`) uses a **semantic/intent-based** condition (spec adds adapter/integration/target ∨ touches `infrastructure/`). The two are complementary: `/R-spec` catches intent-level N×M violations, `/R-dev-review` catches implementation-level ones. See `plugins/shared/references/axial-decomposition.md`.

Skip: R-tester → ¬`delta_test_hit` ∨ `oracle_ok=true` ∨ `oracle_ok=missing` | R-frontend-dev → ¬FE Δ | R-backend-dev → `{backend.path}` empty ∨ Δ misses prefix | R-devops → τ≠F-full ∨ Δ ∩ infra = ∅ | R-architect → τ≠F-full ∨ Δ ∩ infra ≠ ∅ | R-axial-adr-review → ¬∃ axial ADR ∨ Δ misses AXIAL | R-security-auditor → **`¬spawn_security_auditor`** | R-recall → single-chunk ∨ |Δ| ≤ recall_min_delta ∨ ¬canonical class ∨ |callsites|<3

**Subdomain split (multi-chunk):** For each chunk `c_i`, invoke `roster.sh --diff-list <chunk_i.files> …` and spawn that JSON's `agents[]` on `c_i.files` only. Default: 1 agent per domain per chunk. `R-adversarial` is the floor in every chunk. `max_agents` is a per-chunk cap. R-recall is Phase 3b (not per-chunk Lane A). R-finding-verifier is Phase 4 (once per review).

### R-security-auditor scoping

Only when R-security-auditor is actually spawned (`spawn_security_auditor` from the roster oracle — `path_hit`, ¬default):

1. ∀ f ∈ Δ: imports(f) = static `from '...'` ∪ dynamic `import('...')`
2. Resolve aliases:

   | Pattern | Resolution |
   |---------|-----------|
   | `./`, `../` | relative, try `.ts`, `/index.ts` |
   | `@repo/<pkg>` | → `packages/<pkg>/src/index.ts` (skip vitest/playwright config) |
   | `@/*` | → `{frontend.path}/src/` + rest, try `.ts`, `.tsx`, `/index.{ts,tsx}` |
   | External | skip |

3. scope = Δ ∪ ⋃{resolve(imports(f)) | f ∈ Δ} ∪ `{backend.path}/src/auth/**` — deduplicate

# SYNC REQUIRED: inline class list must match review-classes.yml slugs — see #149
# CROSS-SKILL CONSUMER: fix/SKILL.md Phase 0 reads this YAML via ${CLAUDE_PLUGIN_ROOT}/skills/dev-review/review-classes.yml — moving/renaming it breaks /R-fix (#286)
### Spawn template

> **Note (orchestrator):** The `{format_digest_for_agent(d) for d in digests if d.chunk_index != i}` placeholder is a Python expression evaluated by the orchestrator (Claude main context) BEFORE the Task call — substitute its rendered value into the prompt string. It is NOT a runtime-resolved placeholder. All other `{...}` placeholders are simple value substitutions.

**Single-chunk (|chunks| = 1):** agents receive full diff. R-adversarial prompt still includes the OWASP lens. ¬spawn R-recall (Phase 3b skipped).

**Multi-chunk (|chunks| > 1) — Lane A per-chunk:**

For each chunk `c_i`, spawn that chunk's `agents[]` (per-chunk oracle) in parallel:

```
Task(
  subagent_type: "dev-core:{agent}",
  description: "{agent} review — chunk {i}/{N} — {PR#|branch}",
  prompt: "Code review task. Focus: {focus}.\n\nSpawned roster (this review): {agents[]}. Sibling-drop rules key off THIS list — a concern whose owner is ¬in the list is YOURS: keep the finding. If you are R-adversarial: also apply an OWASP lens (secrets, injection, auth); the default panel is R-adversarial alone, so spec-scope, structure and coverage φ are yours unless the roster names R-architect/R-tester (R-product-lead is ¬in the roster at all — Phase 2 owns spec compliance). Output Conventional Comments findings only. ¬TaskCreate.\n\nYou are reviewing chunk {i} of {N}. Review ONLY the files in this chunk.\n\nAdditionally audit each chunk against the systematic blind spots in `${CLAUDE_PLUGIN_ROOT}/skills/dev-review/review-blind-spots.md` — call out each applicable one explicitly (or note none apply).\n\nFormat per finding:\n<label>: <description>\n  <file>:<line>\n  -- {agent}\n  Root cause: <why>\n  Class: [<canonical-class>, ...] [candidate/<slug>?]  ← 0–N canonical from review-classes.yml + 0–1 candidate; omit field if no class applies\n  Raw callsites: [{file: <path>, line: <n>}, ...]  ← all locations of this anti-pattern; required when Class is set; never empty\n  Solutions:\n    1. <primary> (recommended)\n    2. <alternative>\n  Confidence: N%\n\nCanonical classes (use slug only): test-tautology, generator-drift, parallel-path-drift, bash-arithmetic-trap, bash-error-suppression, target-axis-trap, vacuous-guard, shell-injection, sql-injection, missing-error-handling, missing-input-validation, secret-leak, bare-except, path-traversal, unbounded-loop. Free-text labels not in this list or candidate/* namespace are invalid. Candidate slugs must match ^candidate/[a-z][a-z0-9-]{1,48}$. Subsumption: bare-except subsumes missing-error-handling — when both apply, tag bare-except only. parallel-path-drift and target-axis-trap are siblings (¬overlap) — parallel-path-drift for security hardening missing on a sibling entry point, target-axis-trap for architectural concern duplication across the non-primary axis (concern copy-pasted in ≥3 sibling dirs); prefer the matching one, do not double-tag.\n\n---CHUNK DIFF (chunk {i})---\n{c_i.hunk_text for all files in chunk}\n\n---CHUNK FILES---\n{contents of files in c_i}\n\n---BOUNDARY DIGESTS (other chunks)---\n{format_digest_for_agent(d) for d in digests if d.chunk_index != i}\n\n---SPEC---\n{spec contents if ∃, else omit section}"
)
```

Agent name map: `R-adversarial` → `dev-core:R-adversarial` | `R-frontend-dev` → `dev-core:R-frontend-dev` | `R-tester` → `dev-core:R-tester` | `R-architect` → `dev-core:R-architect` | `R-backend-dev` → `dev-core:R-backend-dev` | `R-devops` → `dev-core:R-devops` | `R-recall` → `dev-core:R-recall` | `R-security-auditor` → `dev-core:R-security-auditor` (when **`spawn_security_auditor`** — `path_hit`) | `R-axial-adr-review` → `dev-core:R-axial-adr-review` | `R-finding-verifier` → `dev-core:R-finding-verifier`

### Agent payload

**Single-chunk:** each agent receives full diff + Δ + spec (if ∃) + "output Conventional Comments". R-adversarial: + OWASP lens (secrets, injection, auth).

**Multi-chunk (Lane A):** each agent receives chunk diff + chunk file contents + boundary digests of all *other* chunks + spec (if ∃).

### Phase 3b — Cross-chunk class join + R-recall trigger (multi-chunk only)

After all Lane A agents complete, the orchestrator builds a cross-chunk index and triggers R-recall agents where warranted.

**Step 1 — Build index:**

```
class_index = {}   # class_slug → {chunks: set[int], callsites: [{file, line}]}

∀ chunk c_i, ∀ finding f with class[] ≠ []:
  ∀ cls in f.class[] where ¬cls.startswith("candidate/"):
    class_index[cls].chunks.add(i)
    class_index[cls].callsites.extend(f.raw_callsites)
```

`candidate/*` classes → ¬join (advisory only, never trigger R-recall).

**Step 2 — Trigger condition (per class) — ALL required:**

```
|chunks| > 1                            → else skip Phase 3b (single-chunk: never R-recall)
cls is canonical (¬candidate/*) already tagged
|class_index[cls].callsites| ≥ 3
```

Skip R-recall on single-chunk even if ≥3 callsites. ¬density-within-single-chunk trigger.

**Step 3 — Spawn R-recall agent per triggered class:**

```
Task(
  subagent_type: "dev-core:R-recall",
  description:   "R-recall — {cls} — {PR#|branch}",
  prompt: "Targeted R-recall task for class '{cls}'.
Input:
  class: {cls}
  callsites: {class_index[cls].callsites}
  context_lines: 10
  cross_chunk_index: {chunks: {class_index[cls].chunks}, agents: {agents_that_flagged}}

Follow agents/R-recall.md procedure. Output Conventional Comments findings only.
All R-recall findings MUST use label `issue(blocking):`. ¬TaskCreate."
)
```

R-recall agents run ∥. Collect findings → Phase 4 merge.

**Single-chunk path:** skip Phase 3b entirely (no cross-chunk index needed).

### Review dimensions
correctness | security | performance | architecture | tests | readability | observability

### Finding format (ALL fields mandatory except Class/Raw callsites)

```
<label>: <description>
  <file>:<line>
  -- <agent>
  Root cause: <why, not what>
  Class: [<canonical-class>, ...] [candidate/<slug>?]
  Raw callsites: [{file: <path>, line: <n>}, ...]
  Solutions:
    1. <primary> (recommended)
    2. <alternative>
    3. <alternative> [optional]
  Confidence: <0-100>%
```

**Class field rules:**
- 0–N canonical tags from `${CLAUDE_SKILL_DIR}/review-classes.yml` + 0–1 `candidate/<slug>` tag
- Omit the `Class:` field entirely when no class applies (¬write `Class: []`)
- Free-text labels not in the canonical list and not prefixed `candidate/` → invalid; treat as C(f) := 0
- `candidate/<slug>` must match `^candidate/[a-z][a-z0-9-]{1,48}$`; slug violating format → invalid, C(f) := 0
- `Raw callsites` required when `Class` is set; list ALL locations of the anti-pattern in the diff + resolved imports, never just the cited line; format: `[{file: <path>, line: <n>}, ...]`
- Subsumption: `bare-except` subsumes `missing-error-handling` — when both could apply, tag `bare-except` only
- Subsumption: `parallel-path-drift` ⊥ `target-axis-trap` (siblings, ¬overlap). Authoritative definition + threshold (≥3 sibling dirs) lives in `review-classes.yml` RC-3 and RC-5 — see the `note:` fields there. Tag exactly one; do not double-tag. Enforced by `tools/validate_plugins.py --check subsumption-pairs`.

C(f) = min(diagnostic_certainty, fix_certainty)

| Band | C | Criteria |
|------|---|----------|
| Certain | 90-100 | Unambiguous diagnosis + fix |
| High | 70-89 | Clear diagnosis, 1-2 approaches |
| Moderate | 40-69 | Probable, context-dependent |
| Low | 0-39 | Speculative, competing explanations |

**Validation:** missing mandatory fields ∨ C ∉ ℤ ∩ [0,100] ∨ free-text class label → C(f) := 0 (noted; `/R-fix` routes to 1b1).

### Finding categories

| Category | Label | Blocks? |
|----------|-------|:---:|
| Bug / Security / Spec gap | `issue:` / `todo:` | ✓ |
| Standard violation | `suggestion(blocking):` | ✓ |
| Style | `suggestion(non-blocking):` / `nitpick:` | ✗ |
| Architecture | `thought:` / `question:` | ✗ |
| Good work | `praise:` | ✗ |

## Phase 4 — Merge & Present

1. Collect F from all agents (Lane A + R-recall agents + Lane B)
2. Dedup — **mandatory, two keys, both always applied** (unavoidable; never present two copies):
   - same file:line + issue → keep max C
   - **one finding per `(file, class)` → keep max C** — never two agents' copies of the same class on the same file
   - ∀ pair sharing file:line with class[] sets that intersect after subsumption → merge: max C, union class[] (apply subsumption strip), union raw_callsites[]
3. Classify sources — **before keep/drop**:
   - Lane A findings: standard blocking/advisory per category label
   - Recall findings (`source: recall`): always **blocking** regardless of label — override to `issue(blocking):` if not already
   - Lane B findings (`pattern-class` tag): **advisory only** — cap at `Approve with comments`; ¬Request changes from Lane B alone
4. Keep/drop filter (R-finding-verifier) — see below
5. Sort: C desc within category
6. Group: Blockers → Warnings → Suggestions → Praise
7. Disclose removals — emit in the review output unconditionally (Phase 6 copies; ¬vanish when ¬∃ PR):
   `capped[]`/`warnings[]` are unioned across chunk invocations and deduplicated before disclosure, attributed by chunk where they differ.
   - `Roster capped by max_agents: <names>` when `capped[] ≠ ∅`
# CROSS-SKILL CONSUMER: /R-fix Phase 1 parses Conventional Comments from every PR comment body — the F_dropped block MUST stay table-shaped or the filter is defeated (fix/SKILL.md Phase 1 step 1a strips it)
   - `F_dropped` → collapsed disclosure, **table shape only** (¬Conventional-Comment grammar: a `<label>: <desc>` line would be re-ingested by `/R-fix` and defeat the filter):
     ```markdown
     <details><summary>Filtered by finding-verifier (N)</summary>

     | Dropped | Location | C | Reason |
     |---------|----------|---|--------|
     | {label} | {file}:{line} | {C_orig} | {drop reason} |

     </details>
     ```
     Dropped findings always disclosed, ¬silently discarded.

### Keep/drop filter (R-finding-verifier)

Exactly one instance per review (¬per-chunk, ¬per-finding). Read-only (`Read`, `Grep`, `Glob` only).

```
F_low := {f ∈ F | C(f) < verify_below_confidence ∧ ¬blocks(f)}   # threshold from roster JSON
blocks(f) := label ∈ {issue:, issue(blocking):, todo:, suggestion(blocking):} ∨ source(f) = recall
```

Lane B advisory findings stay eligible for the filter.
Invariant (checkable): no finding that is blocking by label or by source may enter `F_low`.

`blocks(f)` findings are NEVER sent to the filter and never enter `F_dropped`. Verdict depends on `blocks(f)`, ¬an LLM's judgement. `verify_below_confidence` is clamped to `[0, 90]` by the oracle.

Skip when `F_low = ∅ ∨ ¬verifier_enabled`.

```
Task(
  subagent_type: "dev-core:R-finding-verifier",
  description:   "R-finding-verifier — keep/drop — {PR#|branch}",
  prompt: "Keep/drop filter for findings with C < {verify_below_confidence}.
Input:
  threshold: {verify_below_confidence}
  findings: {F_low serialized}

Read-only (Read, Grep, Glob only). Never invent findings. Never re-rank kept findings upward.
Bias: **default keep**. Your rubric is `${CLAUDE_PLUGIN_ROOT}/agents/R-finding-verifier.md` Phase V2 — read it, it is authoritative. Carve-outs that matter: a cross-Δ citation used as *evidence about* a Δ change is IN scope (¬drop), and `speculative with no callsite in Δ` ¬applies to lens ∈ {fleet-regression, bypass, assumption-kill}. Blocking labels ¬∈ your input; if one appears → keep, reason `blocking label — out of filter scope`.

Output, one block per input finding:
finding: <file>:<line> — <label>
  decision: keep | drop
  confidence: <0-100>        # keep only; MUST be ≤ the original C
  reason: <one line, evidence-based>
¬TaskCreate."
)
```

- `keep` → C := min(C_orig, C_verifier)
- `drop` → move to `F_dropped`; excluded from the verdict and from blocker counting
- verifier fails ∨ returns nothing → **keep all of `F_low` unchanged (fail-open — never silently drop)**

**Verdict** (KEPT findings only; `F_dropped` excluded from blocker counting):

| Condition | Verdict |
|-----------|---------|
| ∃f ∈ F_kept: recall finding (source: recall) | Request changes |
| ∃f ∈ F_kept: blocks(f) ∧ ¬recall | Request changes |
| Lane B advisory ∨ warns(f) only ∧ ¬blocks | Approve with comments |
| suggestions/praise only | Approve |
| F_kept = ∅ | Approve (clean) |

## Phase 6 — Post to PR

1. PR# = provided ∨ `gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number'`; ¬∃ → skip
2. Tempfile per `${CLAUDE_PLUGIN_ROOT}/../shared/references/tempfile-convention.md`:
   ```bash
   [[ "$PR" =~ ^[0-9]+$ ]] || { echo "Invalid PR number: $PR" >&2; exit 1; }
   TMPDIR=$(mktemp -d -t "dev-core-review-comment-PR${PR}-XXXXXX")
   trap 'rm -rf "$TMPDIR"' EXIT
   BODY="$TMPDIR/body.md"
   ```
   Write grouped findings to `"$BODY"` → `gh pr comment "$PR" --body-file "$BODY"`
3. `## Code Review` header; grouped findings + summary + verdict; ∀C included.
4. Copy the Phase 4 Disclose-removals block (`Filtered by finding-verifier (N)` table + `Roster capped by max_agents: <names>`) into the PR body. Do ¬re-render, ¬recompute.

**→ immediately continue to Phase 8.**

## Phase 8 — Next Step

Q:
- **Fix now (`/R-fix`)** — invoke `/R-fix` (auto-apply + 1b1 + spawn fixers; `/R-fix` Phase 8 offers rebase + label + merge)
- **Merge as-is** — rebase + label + auto-merge (below)
- **Stop** — exit

**If Merge as-is:**

1. `git fetch origin ${BASE} && git rev-list HEAD..origin/${BASE} --count`
   - count > 0 → `git rebase origin/${BASE}` + `git push --force-with-lease`
   - conflict → halt (¬label)
2. Q: "Add `reviewed` label?" → Yes / No
3. Yes → `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"` → auto-merge merges (merge commit) on green CI. ¬auto-merge workflow in repo → `gh pr merge <#> --auto --merge`. ¬plain `gh pr merge` while any check is IN_PROGRESS/QUEUED — mid-CI merge cancels in-flight runs + skips gates.
4. No → inform manual

> `/R-dev-review` ¬fixes code. Fixing = `/R-fix` skill.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| |Δ| = 0 | Halt |
| Binary ∈ Δ | Skip, note |
| |Δ| > 50 | Warn, suggest split |
| F = ∅ | Clean approve, post, Phase 8 |
| Critical security | Escalate in findings, flag in verdict |
| Agents disagree | Present both with respective C |
| ¬∃ PR | Skip Phase 6, Phase 8 local only |
| Missing root cause/solutions | C(f) := 0 |
| R-architect skipped | τ≠F-full |
| R-tester skipped | ¬delta_test_hit ∨ oracle_ok=true → ¬coverage review |
| R-security-auditor skipped | path_hit=false — R-adversarial owns OWASP on every review |
| ∃f: C < verify_below_confidence | R-finding-verifier keep/drop pass |
| R-finding-verifier ¬returns | keep all F_low (fail-open) |
| roster capped (max_agents) | disclosed unconditionally (Phase 4) |
| oracle warnings ≠ ∅ | echoed into output; review_halt → HALT |

## Safety Rules

1. Fresh agents only — ¬implementation context
2. ¬approve PRs on GitHub; ¬enable auto-merge outside the Phase 8 human decision (label gate)
3. Merge = merge commit only, ¬squash (see [`release-convention.md`](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/release-convention.md)); merge executes via the gate (label + auto-merge), never manually mid-CI
4. ¬fix code — findings only. Fixing = `/R-fix` skill
5. ∃ PR → must post comment (Phase 6)
6. Human decides at Phase 8 — ¬proceed without Q

## Chain Position

- **Phase:** Verify
- **Predecessor:** `/R-validate`
- **Successor:** conditional — APPROVED → merge → `/R-cleanup` | CHANGES_REQUESTED → `/R-fix`
- **Class:** verdict (branching based on findings)

## Task Integration

- `/R-dev` owns the dev-pipeline task lifecycle externally
- Sub-tasks created: review findings (`kind: "review-finding"`) if applicable
- Follow-up tasks: on CHANGES_REQUESTED (user picks `/R-fix` at Phase 8) → `TaskCreate` fix task with `metadata: { kind: "dev-pipeline", follow_up: true, iteration: N, blockedBy: [this.id] }`

## Exit

- **APPROVED via `/R-dev`** (user picks Merge as-is at Phase 8): rebase + label + merge → return. `/R-dev` advances to `/R-cleanup`.
- **CHANGES_REQUESTED via `/R-dev`** (user picks `/R-fix` at Phase 8): `TaskCreate` follow-up fix task → return silently. `/R-dev` picks up the new task and invokes `/R-fix`.
- **Stop (user)**: return → `/R-dev` presents Abort | Resume.
- **Loop cap:** max 2 fix→review iterations (tracked via `metadata.iteration`). 3rd review iteration → Phase 8 must recommend Merge as-is or Stop, not Fix. `/R-dev` presents Abort if 3rd fix attempted.

$ARGUMENTS
