---
name: dev-review
argument-hint: [#PR]
description: Multi-domain code review (agents + Conventional Comments → findings + verdict). Triggers: "dev-review" | "code review" | "review changes" | "review PR #42" | "check my code" | "review my changes" | "review this PR" | "do a code review" | "review the diff" | "look at my code".
version: 0.2.3
allowed-tools: Bash, Read, Write, Glob, Grep, Task, Skill, ToolSearch
---

# Code Review

## Success

I := F collected ∧ verdict posted (PR ∃) ∧ Phase 8 decision made
V := `gh pr view {N} --comments | grep "## Code Review"` ∧ verdict ∈ {Approve, Request changes}

Review branch/PR via fresh domain-specific agents → Conventional Comments → findings + verdict.

**⚠ Flow: single continuous pipeline (Phases 1→4 + 6 + 8). ¬stop between phases. Decision response → immediately execute next phase. Stop only on: |Δ|=0, explicit Cancel, or Phase 8 completion.**

```
/dev-review          → diff origin/${BASE}...HEAD  (BASE = staging|main|master, first that exists)
/dev-review #42      → gh pr diff 42
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
| 3 | multi-domain-review | ✓ | agents return | parallel |
| 4 | merge-and-present | ✓ | F + verdict | — |
| 6 | post-to-pr | — | comment posted | PR ∃ |
| 8 | next-step | ✓ | decision made | — |

## Pre-flight

Success: F collected ∧ verdict posted ∧ Phase 8 decision made
Evidence: `gh pr view {N} --comments | grep "## Code Review"`
Steps: gather-changes → secret-scan → multi-domain-review → merge-and-present → post-to-pr → next-step
¬clear → STOP + ask: "Which branch/PR to review?"

## Phase 1 — Gather Changes

0. `BASE=$(git rev-parse --verify origin/staging >/dev/null 2>&1 && echo staging || { git rev-parse --verify origin/main >/dev/null 2>&1 && echo main || echo master; })`
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
   - `/dev-review #PR` → `gh pr view PR --json body,headRefName` → `(Fixes|Closes|Resolves) #(\d+)` in body; else first `N` from `feat/{N}-*` in `headRefName`
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
(`skill://dev-review/chunker.py` · Claude/Grok: `$CLAUDE_SKILL_DIR/chunker.py` · Cursor: `chunker.py`).

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

### Claim-axis spawn oracle (#419)

Before Lane A dispatch, compute **once per review** (global, not per-chunk):

```bash
# spec_path from Phase 2; write Δ paths to a mktemp file (see tempfile-convention.md)
REVIEW_TMP=$(mktemp -d -t "dev-core-review-delta-419-XXXXXX")
trap 'rm -rf "$REVIEW_TMP"' EXIT
printf '%s\n' "${DELTA_FILES[@]}" > "$REVIEW_TMP/delta.txt"
bash skill://dev-review/claim-roster.sh \
  --spec "$spec_path" \
  --diff-list "$REVIEW_TMP/delta.txt" \
  --json
# Claude/Grok: bash "$CLAUDE_SKILL_DIR/claim-roster.sh" … (same flags)
# spawn_security_auditor := JSON field; exit 2 when priced fences lack valid claim (still spawn)
```

Interim: `Claims` = all valid tags on approved σ when Δ ≠ ∅ (true source∩Δ deferred). No approved σ → path-only.

### Agent dispatch

τ ← spec/plan frontmatter ∨ issue labels (default F-lite if unknown).

| Agent | When | Focus |
|-------|------|-------|
| **adversarial** | **always** | red-team: bypass, fleet-regression, vacuous guards, assumption-kill + **OWASP lens** (secrets, injection, auth). security-auditor is independent when Δ ∩ auth/secrets/crypto (both may run) |
| **frontend-dev** | Δ ∩ {FE, `{frontend.path}`, `{shared.ui}`} ≠ ∅ | FE patterns, components, hooks |
| **product-lead** | spec ∃ | spec compliance, product fit |
| **tester** | `bash skill://pr/run-falsify.sh --verify artifacts/reviews/{N}-falsify.json` (Claude/Grok: `$CLAUDE_PLUGIN_ROOT/skills/pr/run-falsify.sh`) yields `oracle_ok=false` (or JSON missing) | coverage, AAA, edge cases, tautology |
| **architect** | τ=F-full ∨ Δ ∩ {`scripts/`, CI, `lefthook.yml`, wrangler, deploy} ≠ ∅ | patterns, structure, circular deps |
| **backend-dev** | τ=F-full ∨ Δ ∩ {`scripts/`, CI, `lefthook.yml`, wrangler, deploy, `{backend.path}`} ≠ ∅ | BE patterns, API, errors |
| **devops** | τ=F-full ∨ Δ ∩ {`scripts/`, CI, `lefthook.yml`, wrangler, deploy} ≠ ∅ | config, deploy, infra |
| **recall** | **only** multi-chunk ∧ canonical class already tagged ∧ ≥3 raw_callsites. Skip on single-chunk | class-join, uncited callsites — Phase 3b, ¬Lane A |
| **security-auditor** | **`spawn_security_auditor`** from S1 `claim-roster.sh` — `path_hit` (Δ ∩ {auth, secrets, crypto, `**/auth/**`, `**/*secret*`, `**/*crypto*`}) ∨ claim tags on approved σ when Δ≠∅ ∨ invalid `claim` on priced fence (#419) | OWASP, secrets, injection, auth |
| **axial-adr-review** | ∃ axial ADR (`axial: true` ∈ `docs/architecture/adr/`) ∧ Δ ∩ {`infrastructure/`, `adapters/`, `domains/`, `stages/`} ≠ ∅ | Drift along non-primary axis (target × concern duplication) — read-only review agent (no Write/Edit/Bash tools) |

> **Note on axial-adr-review asymmetry (intentional):** The `/dev-review` condition is **structural** — it triggers when the diff touches `infrastructure/`, `adapters/`, `domains/`, or `stages/`. The spec phase (`/spec`) uses a **semantic/intent-based** condition (spec adds adapter/integration/target ∨ touches `infrastructure/`). The two are complementary: `/spec` catches intent-level N×M violations, `/dev-review` catches implementation-level ones. See `plugins/shared/references/axial-decomposition.md`.

Skip: product-lead → spec ∄ | tester → `bash skill://pr/run-falsify.sh --verify artifacts/reviews/{N}-falsify.json` (Claude/Grok: `$CLAUDE_PLUGIN_ROOT/skills/pr/run-falsify.sh`) emits `oracle_ok=true` (markdown / `parse-falsify` alone is ¬sufficient; verify fail → spawn tester) | frontend-dev → ¬FE Δ | architect/devops → τ≠F-full ∧ Δ misses `scripts/`/CI/`lefthook.yml`/wrangler/deploy | backend-dev → τ≠F-full ∧ Δ misses those ∧ `{backend.path}` | security-auditor → **`¬spawn_security_auditor`** (S1 `claim-roster` — **not** path-only “Δ misses auth/secrets/crypto”) | recall → single-chunk ∨ ¬canonical class ∨ \|callsites\|<3

**Subdomain split (multi-chunk):** For each chunk `c_i`, apply the dispatch table against `c_i.files` only (not full Δ). Default: 1 agent per domain per chunk. recall is Phase 3b (not per-chunk Lane A).

### Security-auditor scoping

Only when security-auditor is actually spawned (`spawn_security_auditor` from S1, ¬default):

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
# CROSS-SKILL CONSUMER: fix/SKILL.md Phase 0 reads `skill://dev-review/review-classes.yml` (Claude/Grok: `$CLAUDE_PLUGIN_ROOT/skills/dev-review/review-classes.yml`) — moving/renaming it breaks /fix (#286)
### Spawn template

> **Note (orchestrator):** The `{format_digest_for_agent(d) for d in digests if d.chunk_index != i}` placeholder is a Python expression evaluated by the orchestrator (Claude main context) BEFORE the Task call — substitute its rendered value into the prompt string. It is NOT a runtime-resolved placeholder. All other `{...}` placeholders are simple value substitutions.

**Single-chunk (|chunks| = 1):** agents receive full diff. Adversarial prompt still includes the OWASP lens. ¬spawn recall (Phase 3b skipped).

**Multi-chunk (|chunks| > 1) — Lane A per-chunk:**

For each chunk `c_i`, spawn the applicable domain agents in parallel:

```
Task(
  subagent_type: "dev-core:{agent}",
  description: "{agent} review — chunk {i}/{N} — {PR#|branch}",
  prompt: "Code review task. Focus: {focus}. If you are adversarial: also apply an OWASP lens (secrets, injection, auth) — ¬expect a sibling security-auditor unless the orchestrator spawned one (orchestrator MAY spawn one when Δ ∩ auth/secrets/crypto, independent of adversarial). Output Conventional Comments findings only. ¬TaskCreate.\n\nYou are reviewing chunk {i} of {N}. Review ONLY the files in this chunk.\n\nAdditionally audit each chunk against the systematic blind spots in `${CLAUDE_PLUGIN_ROOT}/skills/dev-review/review-blind-spots.md` — call out each applicable one explicitly (or note none apply).\n\nFormat per finding:\n<label>: <description>\n  <file>:<line>\n  -- {agent}\n  Root cause: <why>\n  Class: [<canonical-class>, ...] [candidate/<slug>?]  ← 0–N canonical from review-classes.yml + 0–1 candidate; omit field if no class applies\n  Raw callsites: [{file: <path>, line: <n>}, ...]  ← all locations of this anti-pattern; required when Class is set; never empty\n  Solutions:\n    1. <primary> (recommended)\n    2. <alternative>\n  Confidence: N%\n\nCanonical classes (use slug only): test-tautology, generator-drift, parallel-path-drift, bash-arithmetic-trap, bash-error-suppression, target-axis-trap, vacuous-guard, shell-injection, sql-injection, missing-error-handling, missing-input-validation, secret-leak, bare-except, path-traversal, unbounded-loop. Free-text labels not in this list or candidate/* namespace are invalid. Candidate slugs must match ^candidate/[a-z][a-z0-9-]{1,48}$. Subsumption: bare-except subsumes missing-error-handling — when both apply, tag bare-except only. parallel-path-drift and target-axis-trap are siblings (¬overlap) — parallel-path-drift for security hardening missing on a sibling entry point, target-axis-trap for architectural concern duplication across the non-primary axis (concern copy-pasted in ≥3 sibling dirs); prefer the matching one, do not double-tag.\n\n---CHUNK DIFF (chunk {i})---\n{c_i.hunk_text for all files in chunk}\n\n---CHUNK FILES---\n{contents of files in c_i}\n\n---BOUNDARY DIGESTS (other chunks)---\n{format_digest_for_agent(d) for d in digests if d.chunk_index != i}\n\n---SPEC---\n{spec contents if ∃, else omit section}"
)
```

Agent name map: `adversarial` → `dev-core:adversarial` | `frontend-dev` → `dev-core:frontend-dev` | `product-lead` → `dev-core:product-lead` | `tester` → `dev-core:tester` | `architect` → `dev-core:architect` | `backend-dev` → `dev-core:backend-dev` | `devops` → `dev-core:devops` | `recall` → `dev-core:recall` | `security-auditor` → `dev-core:security-auditor` (when **`spawn_security_auditor`** from `claim-roster.sh`, ¬default) | `axial-adr-review` → `dev-core:axial-adr-review`

### Agent payload

**Single-chunk:** each agent receives full diff + Δ + spec (if ∃) + "output Conventional Comments". Adversarial: + OWASP lens (secrets, injection, auth).

**Multi-chunk (Lane A):** each agent receives chunk diff + chunk file contents + boundary digests of all *other* chunks + spec (if ∃).

### Phase 3b — Cross-chunk class join + recall trigger (multi-chunk only)

After all Lane A agents complete, the orchestrator builds a cross-chunk index and triggers recall agents where warranted.

**Step 1 — Build index:**

```
class_index = {}   # class_slug → {chunks: set[int], callsites: [{file, line}]}

∀ chunk c_i, ∀ finding f with class[] ≠ []:
  ∀ cls in f.class[] where ¬cls.startswith("candidate/"):
    class_index[cls].chunks.add(i)
    class_index[cls].callsites.extend(f.raw_callsites)
```

`candidate/*` classes → ¬join (advisory only, never trigger recall).

**Step 2 — Trigger condition (per class) — ALL required:**

```
|chunks| > 1                            → else skip Phase 3b (single-chunk: never recall)
cls is canonical (¬candidate/*) already tagged
|class_index[cls].callsites| ≥ 3
```

Skip recall on single-chunk even if ≥3 callsites. ¬density-within-single-chunk trigger.

**Step 3 — Spawn recall agent per triggered class:**

```
Task(
  subagent_type: "dev-core:recall",
  description:   "recall — {cls} — {PR#|branch}",
  prompt: "Targeted recall task for class '{cls}'.
Input:
  class: {cls}
  callsites: {class_index[cls].callsites}
  context_lines: 10
  cross_chunk_index: {chunks: {class_index[cls].chunks}, agents: {agents_that_flagged}}

Follow agents/recall.md procedure. Output Conventional Comments findings only.
All recall findings MUST use label `issue(blocking):`. ¬TaskCreate."
)
```

Recall agents run ∥. Collect findings → Phase 4 merge.

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

**Validation:** missing mandatory fields ∨ C ∉ ℤ ∩ [0,100] ∨ free-text class label → C(f) := 0 (noted; `/fix` routes to 1b1).

### Finding categories

| Category | Label | Blocks? |
|----------|-------|:---:|
| Bug / Security / Spec gap | `issue:` / `todo:` | ✓ |
| Standard violation | `suggestion(blocking):` | ✓ |
| Style | `suggestion(non-blocking):` / `nitpick:` | ✗ |
| Architecture | `thought:` / `question:` | ✗ |
| Good work | `praise:` | ✗ |

## Phase 4 — Merge & Present

1. Collect F from all agents (Lane A + recall agents + Lane B)
2. Dedup — **mandatory, two keys, both always applied** (unavoidable; never present two copies):
   - same file:line + issue → keep max C
   - **one finding per `(file, class)` → keep max C** — never two agents' copies of the same class on the same file
   - ∀ pair sharing file:line with class[] sets that intersect after subsumption → merge: max C, union class[] (apply subsumption strip), union raw_callsites[]
3. Sort: C desc within category
4. Group: Blockers → Warnings → Suggestions → Praise

**Source classification before verdict:**
- Lane A findings: standard blocking/advisory per category label
- Recall findings (`source: recall`): always **blocking** regardless of label — override to `issue(blocking):` if not already
- Lane B findings (`pattern-class` tag): **advisory only** — cap at `Approve with comments`; ¬Request changes from Lane B alone

**Verdict:**

| Condition | Verdict |
|-----------|---------|
| ∃f: recall finding (source: recall) | Request changes |
| ∃f: blocks(f) ∧ ¬recall | Request changes |
| Lane B advisory ∨ warns(f) only ∧ ¬blocks | Approve with comments |
| suggestions/praise only | Approve |
| F = ∅ | Approve (clean) |

## Phase 6 — Post to PR

1. PR# = provided ∨ `gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number'`; ¬∃ → skip
2. Tempfile per `skill://shared-refs/tempfile-convention.md` (Claude/Grok: `$CLAUDE_PLUGIN_ROOT/skills/shared-refs/tempfile-convention.md`):
   ```bash
   [[ "$PR" =~ ^[0-9]+$ ]] || { echo "Invalid PR number: $PR" >&2; exit 1; }
   TMPDIR=$(mktemp -d -t "dev-core-review-comment-PR${PR}-XXXXXX")
   trap 'rm -rf "$TMPDIR"' EXIT
   BODY="$TMPDIR/body.md"
   ```
   Write grouped findings to `"$BODY"` → `gh pr comment "$PR" --body-file "$BODY"`
3. `## Code Review` header; grouped findings + summary + verdict; ∀C included

**→ immediately continue to Phase 8.**

## Phase 8 — Next Step

Q:
- **Fix now (`/fix`)** — invoke `/fix` (auto-apply + 1b1 + spawn fixers; `/fix` Phase 8 offers rebase + label + merge)
- **Merge as-is** — rebase + label + auto-merge (below)
- **Stop** — exit

**If Merge as-is:**

1. `git fetch origin ${BASE} && git rev-list HEAD..origin/${BASE} --count`
   - count > 0 → `git rebase origin/${BASE}` + `git push --force-with-lease`
   - conflict → halt (¬label)
2. Q: "Add `reviewed` label?" → Yes / No
3. Yes → `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"` → auto-merge merges (merge commit) on green CI. ¬auto-merge workflow in repo → `gh pr merge <#> --auto --merge`. ¬plain `gh pr merge` while any check is IN_PROGRESS/QUEUED — mid-CI merge cancels in-flight runs + skips gates.
4. No → inform manual

> `/dev-review` ¬fixes code. Fixing = `/fix` skill.

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
| architect skipped | ¬arch review → faster |
| product-lead skipped | Phase 2 skipped |
| tester skipped | `run-falsify --verify` → `oracle_ok=true` → ¬coverage review |
| security-auditor skipped | `¬spawn_security_auditor` (S1 claim-roster) — adversarial still owns OWASP on every review |

## Safety Rules

1. Fresh agents only — ¬implementation context
2. ¬approve PRs on GitHub; ¬enable auto-merge outside the Phase 8 human decision (label gate)
3. Merge = merge commit only, ¬squash (see [`release-convention.md`](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/release-convention.md)); merge executes via the gate (label + auto-merge), never manually mid-CI
4. ¬fix code — findings only. Fixing = `/fix` skill
5. ∃ PR → must post comment (Phase 6)
6. Human decides at Phase 8 — ¬proceed without Q

## Chain Position

- **Phase:** Verify
- **Predecessor:** `/validate`
- **Successor:** conditional — APPROVED → merge → `/cleanup` | CHANGES_REQUESTED → `/fix`
- **Class:** verdict (branching based on findings)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- Sub-tasks created: review findings (`kind: "review-finding"`) if applicable
- Follow-up tasks: on CHANGES_REQUESTED (user picks `/fix` at Phase 8) → `TaskCreate` fix task with `metadata: { kind: "dev-pipeline", follow_up: true, iteration: N, blockedBy: [this.id] }`

## Exit

- **APPROVED via `/dev`** (user picks Merge as-is at Phase 8): rebase + label + merge → return. `/dev` advances to `/cleanup`.
- **CHANGES_REQUESTED via `/dev`** (user picks `/fix` at Phase 8): `TaskCreate` follow-up fix task → return silently. `/dev` picks up the new task and invokes `/fix`.
- **Stop (user)**: return → `/dev` presents Abort | Resume.
- **Loop cap:** max 2 fix→review iterations (tracked via `metadata.iteration`). 3rd review iteration → Phase 8 must recommend Merge as-is or Stop, not Fix. `/dev` presents Abort if 3rd fix attempted.

$ARGUMENTS
