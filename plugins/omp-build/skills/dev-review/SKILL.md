---
name: dev-review
argument-hint: '[#PR]'
description: >-
  OMP-only multi-domain code review — five-role evidence-selected panel, Conventional Comments, findings + verdict.
  Triggers: "dev-review" | "code review" | "review changes" | "review PR #42" | "check my code" | "review my changes" | "review this PR" | "do a code review" | "review the diff".
  Not the host native /review, not Matt code-review.
version: 0.1.0
---

# Code Review

## Success

I := F collected ∧ verdict posted (PR ∃) ∧ Phase 8 decision made
V := `gh pr view {N} --comments | grep "## Code Review"` ∧ verdict ∈ {Approve, Request changes}

Review branch/PR via fresh agents → Conventional Comments → findings + verdict.

**⚠ Flow: single continuous pipeline (Phases 1→4 + 8). ¬stop between phases. Decision response → immediately execute next phase. Stop only on: |Δ|=0, explicit Cancel, roster `review_halt`, or Phase 8 completion.**

```
/skill:dev-review          → diff origin/${BASE}...HEAD  (BASE = staging|main|master, first that exists)
/skill:dev-review #42      → gh pr diff 42
```

Let:
  F := set of all findings | f ∈ F := single finding
  C(f) ∈ [0,100] ∩ ℤ — confidence | cat(f) ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
  Δ := changed files | BASE := staging ∨ main
  τ := tier (S | F-lite | F-full)
  Q := present choice, wait for user reply
  `$SKILL_DIR` := the skill directory announced with this body — an environment variable this skill does **not** produce. Every fence that uses it asserts it first; unset means stop, never an empty prefix.

**Stack:** read `.dev/stack.yml` first — every `{field}` placeholder below resolves from it. ¬∃ → the roster still runs (it warns that overrides are ignored); say so once and continue.

## Pipeline

| Phase | ID | Required | Verifies via | Notes |
|-------|----|----------|---------------|-------|
| 1 | gather-changes | ✓ | Δ listed | — |
| 1.5 | secret-scan | ✓ | ∅ matches (or ACK) | — |
| 2 | spec-compliance | — | criteria checked | σ ∃ |
| 3 | multi-domain-review | ✓ | agents return | parallel · roster oracle |
| 4 | merge-render-post | ✓ | F + verdict (+ PR comment when PR ∃) | dedup → classify → render once → verdict → post |
| 8 | next-step | ✓ | decision made | — |

## Pre-flight

Success: F collected ∧ verdict posted ∧ Phase 8 decision made
Evidence: `gh pr view {N} --comments | grep "## Code Review"`
Steps: gather-changes → secret-scan → spec-compliance → multi-domain-review → merge-render-post → next-step
¬clear → STOP + ask: "Which branch/PR to review?"

## Phase 1 — Gather Changes

0. Source the shared helpers. `skill://` rejects `..`, so `lib.sh` (one level up, outside any skill directory) is reachable only from a real path — and an unset `SKILL_DIR` would silently make that path `/../shared/lib.sh`, i.e. a base branch detected against nothing:

   ```bash
   SKILL_DIR="${SKILL_DIR:?dev-review Phase 1: skill directory not announced — export SKILL_DIR to this skill's directory and re-run}"
   BASE=$(. "$SKILL_DIR/../shared/lib.sh" && detect_base_branch)
   ```
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

**Resolve issue + spec (deterministic):**

1. **issue_num** — priority:
   - `#PR` argument → `gh pr view PR --json body,headRefName` → `(Fixes|Closes|Resolves) #(\d+)` in body; else first `N` from `<type>/{N}-*` in `headRefName`
   - else current branch → `<type>/{N}-*` match; else first `\d+` run (warn: legacy branch fallback)
2. **σ is the tracker issue body** (ADR-020 §4) — `gh issue view {issue_num} --json body --jq .body`. There is no `artifacts/specs` on OMP: ¬glob for one, ¬read frontmatter for `status`, ¬gate on `validated`.
3. σ ∄ (no issue resolved) → skip steps 4–4a; path-only roster.
4. σ ∃ → ∀ criterion: met → ∅ | ¬met → `issue(blocking):` | ∀ met → `praise:`
4a. **Retain Σ (review-output display input, ¬a finding source):** Σ := [{criterion_text, verdict ∈ {met, missing}}] ∀ criterion — a **mirror of step 4**, same binary call, ¬a second judgement. `criterion_text` is the σ line already read in step 4 (verbatim, trimmed); `missing` ⟺ step 4 emitted `issue(blocking):` for that criterion. ¬`ac_id` (no AC-numbering scheme exists — a positional id would be fabricated), ¬`partial`, ¬scope-creep set: none has a producer in steps 1–4, and an unproduced row is an invented one. Σ carries ¬label, ¬C, ¬class: it adds no blocker and ¬enters F.
5. SC→Test matrix (τ≠S): matrix ∃ in PR body → verify no silent gaps (every SC has a row), NO TEST reasons ∈ `{infra-not-wired, prompt-logic-only, ui-manual-only, out-of-scope}` enum. ¬matrix ∧ τ≠S → `issue(blocking):` missing SC→Test matrix.

### τ comes from the `size:` label — nothing else

```bash
TIER=$(gh issue view "$issue_num" --json labels \
  --jq '[.labels[].name | select(startswith("size:"))][0] // empty' | sed 's/^size://')
```

`docs/agents/issue-tracker.md` § Labels: the `size:` label is the **only** source of τ. With spec frontmatter gone (ADR-020 §4), there is no second place to look — ¬infer τ from |Δ|, ¬from the issue title, ¬from a spec file.

∄ label ∨ ∄ issue_num → τ := `F-lite` **and say so out loud**: "no `size:` label on #N — review tier defaults to F-lite". A silent default is the failure `issue-triage` exists to prevent.

## Phase 3 — Multi-Domain Review (Fresh Agents)

Spawn fresh agents via `task` (¬implementation context → ¬bias).

### Chunking

Before dispatching agents, partition Δ with the Python chunker (`skill://dev-review/chunker.py`).

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

- `len(chunks) == 1` → single-chunk path: all agents receive the full diff.
- `len(chunks) > 1` → per-chunk dispatch (below).

### Roster oracle

SOLE spawn decision for Phase 3. τ from the `size:` label (above). `CHUNKS := |chunks|` from the chunker.

**Global vs per-chunk.** Single-chunk: one `roster.sh --diff-list` (Δ = the chunk). Multi-chunk: one allocate call (`--diff-list` full Δ + one `--chunk-list` per chunk). `--chunk-list` count defines `chunks`; omit `--chunks` on this path. Scope check both directions: a chunk path outside Δ, a path in two chunks, or a Δ path in no chunk → warning. Spawn exactly `chunk_agents[i]` on chunk i. The sibling-drop roster passed to an agent is that chunk's `chunk_agents[i]`, never the review-wide union; single-chunk uses `agents[]`.

**Panel invariant:** every chunk gets the `R-adversarial` floor plus at most two relevant specialists (`max_agents` default is `3`). Selection is evidence-based from that chunk's paths and diff signals, not static manifest order. Priority is floor → security path → architect axial mode → devops → tester → architect structural mode. `always`/`never` overrides remain authoritative; forced roles bypass the cap and are never silently dropped.

Spawn exactly `chunk_agents[i]` (multi-chunk) or `agents[]` (single-chunk) from the JSON. The dispatch table below documents oracle gates; it is not a second decision surface. The roster JSON keeps `agents`, `candidates`, `gates`, `capped`, and `max_agents`; allocation additionally keeps `chunk_agents` and `chunk_gates`, index-aligned. **On the multi-chunk path `gates` and the rest of the top level describe the full Δ, not chunk i** — they are the review-wide signal summary. Every per-chunk question (why did this chunk spawn this role, what did this chunk's cap drop) is answered by `chunk_gates[i]` and nothing else. It returns no phase-owned workers and no recall/filter gates. Echo every `warnings[]` entry. `review_halt: true` → HALT with the warning text. A `max_agents_review` key is still parsed so a project carrying it hears a deprecation warning; it has no field and no effect. Legacy recall sizing and override inputs are ignored no-ops with warnings. A stack override naming a cut role (`R-frontend-dev`, `R-backend-dev`, `R-fixer`) warns and is dropped — it never resurrects the role. `R-product-lead` is outside the review roster because Phase 2 owns spec compliance.

```bash
# σ from Phase 2; write Δ paths — and the issue body, when priced fences are in it —
# to a mktemp dir. Never a fixed /tmp path.
REVIEW_TMP=$(mktemp -d -t "omp-build-review-delta-XXXXXX")
trap 'rm -rf "$REVIEW_TMP"' EXIT
printf '%s\n' "${DELTA_FILES[@]}" > "$REVIEW_TMP/delta.txt"
gh issue view "$issue_num" --json body --jq .body > "$REVIEW_TMP/spec.md"   # optional
# single-chunk
bash skill://dev-review/roster.sh \
  --diff-list "$REVIEW_TMP/delta.txt" \
  --tier "$TIER" \
  --chunks "$CHUNKS" \
  [--spec "$REVIEW_TMP/spec.md"] \
  --json
# multi-chunk — repeat --chunk-list for every chunk
printf '%s\n' "${CHUNK_I_FILES[@]}" > "$REVIEW_TMP/chunk_${i}.txt"
bash skill://dev-review/roster.sh \
  --diff-list "$REVIEW_TMP/delta.txt" \
  --chunk-list "$REVIEW_TMP/chunk_0.txt" \
  --chunk-list "$REVIEW_TMP/chunk_1.txt" \
  --tier "$TIER" \
  [--spec "$REVIEW_TMP/spec.md"] \
  --json
```

**R-tester gate (one call, one input):** `delta_test_hit` alone decides — changed-test evidence in Δ arms the role, absence leaves it cold. There is no second round-trip: the executable falsify oracle is cut on OMP (ADR-020 §8), so no `--oracle-ok`, no `run-falsify.sh --verify`, no `oracle_ok` field to read and no coverage-gap disclosure to make when it is absent.

Exit: `0` ok · `1` usage/IO error (including unreadable `--spec` or empty `--chunk-list`) · `2` σ priced-fence hygiene (emit the spec-hygiene `issue(blocking):`; JSON remains on stdout). `claims` and `priced_claim_ok` report that hygiene check only and never gate a spawn.

### Agent dispatch

| Agent | Evidence gate | Focus |
|-------|---------------|-------|
| **R-adversarial** | **always; floor in every chunk** | bypass, fleet regression, vacuous guards, assumption-kill + OWASP lens |
| **R-security-auditor** | strong auth/secrets/crypto path or diff evidence (`path_hit`, including `**/auth/**`) | OWASP, secrets, injection, auth |
| **R-architect** | axial ADR + root axial path → axial mode; otherwise architecture/ADR path, workspace graph config, or configured FE+BE crossing → structural mode | axial N×M drift, boundaries, coupling, circular dependencies |
| **R-devops** | infra/config/deploy evidence such as `scripts/`, `.github/`, or `lefthook.yml` | config, deploy, infra |
| **R-tester** | `delta_test_hit` — changed tests in Δ, after devops in priority | coverage, AAA, edge cases, tautology |

Five roles, and that is the whole panel: the oracle selects at most two specialists after the floor unless forced overrides bypass the cap. There is **no** `R-frontend-dev` and **no** `R-backend-dev` here — both are cut (ADR-020 §7), and component, hook, client-behaviour, API, contract and error concerns fall to the `R-adversarial` floor through the sibling-drop rule, which keys off the `Spawned roster:` line in the prompt below. Nothing replaces them; a domain-heavy diff simply gets the floor plus whatever evidence actually fired. Likewise **no** `R-fixer`: `skill://fix` applies findings inline.

Architect requires axial or structural evidence; F-full alone is cold. Axial mode requires an axial ADR (`axial: true` under `docs/architecture/adr/`) plus a root axial path in Δ (`infrastructure/`, `adapters/`, `domains/`, or `stages/`) and also covers read-only structural architecture concerns in that assigned chunk. Structural mode requires an architecture/ADR path, a workspace graph config, or a diff crossing the `frontend.path`/`backend.path` roots configured in `.dev/stack.yml` — that crossing is an architecture signal, not a domain-role gate, and it survives the cut of the domain roles.

Skip: tester → ¬`delta_test_hit` | devops → no infra evidence | architect → no axial/structural evidence | security → `¬spawn_security_auditor`.

**No gate reads τ.** Every row above fires on Δ, the stack overrides and the axial ADR alone — the tier is validated, echoed back in the JSON, and consumed by Phase 2 (SC→Test matrix at τ≠S), never by the oracle. A gate described as tier-driven would be describing a branch that does not exist.

**Subdomain split (multi-chunk):** one allocate call, exact per-chunk spawn from `chunk_agents[i]`, one `R-adversarial` floor per chunk, and at most two selected specialists per chunk. `max_agents` is the active per-chunk cap; it is the only cap. A `max_agents_review` key in `.dev/stack.yml` is parsed, warned about as deprecated, and then has no effect whatsoever — there is no review-wide ceiling to raise or lower.

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

# SYNC REQUIRED: inline class list must match review-classes.yml slugs
# CROSS-SKILL CONSUMER: fix/SKILL.md Phase 0 reads this YAML via `skill://dev-review/review-classes.yml` — moving or renaming it HALTs /fix

### Spawn template

> **Note (orchestrator):** `{format_digest_for_agent(d) for d in digests if d.chunk_index != i}` is a Python expression evaluated by the orchestrator BEFORE the `task` call — substitute its rendered value into the prompt string. It is NOT a runtime-resolved placeholder. All other `{...}` placeholders are simple value substitutions.

**Agent names are bare.** OMP resolves a task agent by exact `name:` from every enabled extension root's `agents/` directory (`omp://task-agent-discovery.md` § Agent lookup) — there is no plugin prefix, and a prefixed name is an `Unknown agent` preflight failure, i.e. a panel that silently does not run. Use `R-adversarial`, `R-security-auditor`, `R-architect`, `R-devops`, `R-tester` verbatim; every one of them ships in `plugins/omp-build/agents/`.

The snapshotted agent bodies call this workflow `/R-dev-review` in their prose — a label inherited from the Claude plugin, not an invocation. The contract they obey is the prompt below; this skill answers to `dev-review`.

**Single-chunk (|chunks| = 1):** agents receive the full diff. Use the same item template with `i=1, N=1` and Δ as the chunk; it is the only spawn carrier, so its recursion guard reaches dual-use agents. At `N=1`, omit `---BOUNDARY DIGESTS---` and say `You are reviewing the full diff.` The adversarial prompt still includes the OWASP lens. Cross-chunk recall is skipped.

**Multi-chunk — per-chunk review:** for each chunk `c_i`, let `agents[] := chunk_agents[i]`.

For `R-architect`, derive `focus` from **that chunk's** gate reason — `chunk_gates[i]`, the row whose `agent` is `R-architect` — before spawning. Never from top-level `gates`: that row is computed over the full Δ, so a Δ that is axial anywhere reports `axial` for every chunk, including the one whose own evidence was a `structure` hit. A reason beginning with `axial` MUST set `focus := "AXIAL MODE (read-only): run the complete axial ADR procedure and also inspect structural boundaries/coupling in this chunk; no writes"`. A `structure` reason sets normal read-only structural review. This mode string is part of the dispatch prompt; the agent must never infer axial mode from the manifest name alone.

One `task` call carries every agent of a chunk, so the panel runs in parallel:

```
task(
  context: "Code review of {PR#|branch}. Findings only — no agent edits code here.",
  tasks: [
    {
      name: "{Agent}Chunk{i}",
      agent: "{agent}",
      task: "Code review task. Focus: {focus}.\n\nSpawned roster (this review): {agents[]}. Sibling-drop rules key off THIS list — a concern whose owner is ¬in the list is YOURS: keep the finding. This panel has five roles and two of them are specialists picked by evidence, so component/hook/client-behaviour and API/contract/error concerns usually have ¬owner: they are yours. If you are R-adversarial: also apply an OWASP lens (secrets, injection, auth); the default panel is R-adversarial alone, so spec-scope, structure and coverage φ are yours unless the roster names R-architect/R-tester (R-product-lead is ¬in the roster at all — Phase 2 owns spec compliance). Output Conventional Comments findings only. ¬spawn agents (¬task, ¬Skill). ¬invoke this skill. Review your assigned scope yourself.\n\nYou are reviewing chunk {i} of {N}. Review ONLY the files in this chunk.\n\nAdditionally audit each chunk against the systematic blind spots in `skill://dev-review/review-blind-spots.md` — call out each applicable one explicitly (or note none apply).\n\nFormat per finding:\n<label>: <description>\n  <file>:<line>\n  -- {agent}\n  Root cause: <why>\n  Class: [<canonical-class>, ...] [candidate/<slug>?]  ← 0–N canonical from review-classes.yml + 0–1 candidate; omit field if no class applies\n  Raw callsites: [{file: <path>, line: <n>}, ...]  ← all locations of this anti-pattern; required when Class is set; never empty\n  Solutions:\n    1. <primary> (recommended)\n    2. <alternative>\n  Confidence: N%\n\nCanonical classes (use slug only): test-tautology, generator-drift, parallel-path-drift, bash-arithmetic-trap, bash-error-suppression, target-axis-trap, vacuous-guard, shell-injection, sql-injection, missing-error-handling, missing-input-validation, secret-leak, bare-except, path-traversal, unbounded-loop. Free-text labels not in this list or candidate/* namespace are invalid. Candidate slugs must match ^candidate/[a-z][a-z0-9-]{1,48}$. Subsumption: bare-except subsumes missing-error-handling — when both apply, tag bare-except only. parallel-path-drift and target-axis-trap are siblings (¬overlap) — parallel-path-drift for security hardening missing on a sibling entry point, target-axis-trap for architectural concern duplication across the non-primary axis (concern copy-pasted in ≥3 sibling dirs); prefer the matching one, do not double-tag.\n\n---CHUNK DIFF (chunk {i})---\n{c_i.hunk_text for all files in chunk}\n\n---CHUNK FILES---\n{contents of files in c_i}\n\n---BOUNDARY DIGESTS (other chunks)---\n{format_digest_for_agent(d) for d in digests if d.chunk_index != i}\n\n---SPEC---\n{σ body if ∃, else omit section}"
    }
  ]
)
```

### Agent payload

**Single-chunk:** identical to § Spawn template with `i=1, N=1` — see there, ¬a second payload spec. That template is the only spawn carrier (it holds `¬spawn agents` / `¬invoke this skill`); do ¬rebuild the prompt from this summary.
**Multi-chunk:** each agent receives its chunk diff + chunk file contents + boundary digests of all other chunks + σ (if ∃).

### Phase 3b — Isolated cross-chunk recall (multi-chunk only)

After per-chunk agents complete, build a deterministic class index and spawn one fresh read-only exploration worker per triggered class. On OMP that worker is the bundled `scout` agent — read-only by construction, not an `omp-build` manifest, and it receives no implementation context and no full diff.

**Step 1 — Build index:**

```
class_index = {}   # class_slug → {chunks: set[int], callsites: set[{file, line}]}

∀ chunk c_i, ∀ finding f with class[] ≠ []:
  ∀ cls in f.class[] where ¬cls.startswith("candidate/"):
    class_index[cls].chunks.add(i)
    class_index[cls].callsites.update(f.raw_callsites)
```

`candidate/*` classes never join and never trigger recall.

**Step 2 — Trigger per class only when all hold:**

```
|chunks| > 1
cls is canonical
|class_index[cls].chunks| ≥ 2
|class_index[cls].callsites| ≥ 3
```

There is no diff-size or confidence knob. A single-chunk concentration never triggers recall.

**Step 3 — Spawn one isolated worker per triggered class:**

```
task(
  context: "Cross-chunk recall for {PR#|branch}. Read-only; no implementation context.",
  tasks: [
    {
      name: "Recall{cls}",
      agent: "scout",
      task: "Fresh isolated read-only recall for canonical class '{cls}'.\n\nInput only:\n  class: {cls}\n  callsites: {class_index[cls].callsites}\n  context_lines: 10\n  cross_chunk_index: {chunks: {class_index[cls].chunks}, agents: {agents_that_flagged}}\n\nProcedure:\n1. RC-3 scope confirmation: read only ±10 lines around every supplied callsite and confirm every sibling entry point is covered.\n2. RC-6 uncited-instance search: use read-only search for structural siblings of the flagged pattern (same signature shape, import, or decorator).\n3. Emit one Conventional Comments finding per confirmed or newly discovered instance. Every finding MUST use `issue(blocking):`, `Source: recall`, the canonical Class, complete Raw callsites, root cause, solutions, and confidence.\n4. If no additional or confirmable instance exists, return a plain scope receipt, not a finding.\n\nRead-only: read/grep/glob only. No write, edit, bash, task, Skill, tests, implementation context, or full diff. Never invent a callsite. Never spawn another worker or invoke this skill."
    }
  ]
)
```

Workers run in parallel. Collect their blocking findings into Phase 4. Single-chunk reviews skip Phase 3b.

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
- 0–N canonical tags from `skill://dev-review/review-classes.yml` + 0–1 `candidate/<slug>` tag
- Omit the `Class:` field entirely when no class applies (¬write `Class: []`)
- Free-text labels not in the canonical list and not prefixed `candidate/` → invalid; treat as C(f) := 0
- `candidate/<slug>` must match `^candidate/[a-z][a-z0-9-]{1,48}$`; slug violating format → invalid, C(f) := 0
- `Raw callsites` required when `Class` is set; list ALL locations of the anti-pattern in the diff + resolved imports, never just the cited line; format: `[{file: <path>, line: <n>}, ...]`
- Subsumption: `bare-except` subsumes `missing-error-handling` — when both could apply, tag `bare-except` only
- Subsumption: `parallel-path-drift` ⊥ `target-axis-trap` (siblings, ¬overlap). Authoritative definition + threshold (≥3 sibling dirs) lives in `review-classes.yml` RC-3 and RC-5 — see the `note:` fields there. Tag exactly one; do not double-tag.

C(f) = min(diagnostic_certainty, fix_certainty)

| Band | C | Criteria |
|------|---|----------|
| Certain | 90-100 | Unambiguous diagnosis + fix |
| High | 70-89 | Clear diagnosis, 1-2 approaches |
| Moderate | 40-69 | Probable, context-dependent |
| Low | 0-39 | Speculative, competing explanations |

**Validation:** missing mandatory fields ∨ C ∉ ℤ ∩ [0,100] ∨ free-text class label → C(f) := 0 (noted; `skill://fix` routes to 1b1).

### Finding categories

| Category | Label | Blocks? |
|----------|-------|:---:|
| Bug / Security / Spec gap | `issue:` / `todo:` | ✓ |
| Standard violation | `suggestion(blocking):` | ✓ |
| Style | `suggestion(non-blocking):` / `nitpick:` | ✗ |
| Architecture | `thought:` / `question:` | ✗ |
| Good work | `praise:` | ✗ |

## Phase 4 — Merge, Render & Post

One phase owns the final finding set, the single rendered review, and the optional PR comment. Findings are never re-rendered in a second presentation step.

1. **Collect F** from Phase 2 spec compliance, per-chunk agents, and isolated recall workers. Every unmet criterion's `issue(blocking):` enters F so a missing spec criterion cannot coexist with `Approve (clean)`.
2. **Deterministic dedup — both keys always apply:**
   - same file:line + issue → keep max C
   - one finding per `(file, class)` → keep max C
   - findings sharing file:line and intersecting class sets after subsumption → merge with max C, subsumed class stripping, and unioned `Raw callsites`
3. **Classify:** normal findings follow their category label. A finding with `Source: recall` is always blocking; normalize its label to `issue(blocking):`.
4. **Keep by default:** after deterministic dedup, every finding remains in F. Confidence controls ordering and `skill://fix` handling only; no confidence threshold, agent judgement, or second LLM pass may remove a finding. Blocking findings are never filtered.
5. **Sort and group:** C descending within Blockers → Warnings → Suggestions → Praise.
6. **Disclose roster allocation** in the review output whenever non-empty: `capped[]` (the per-chunk union) and `warnings[]`.

`blocks(f) := label ∈ {issue:, issue(blocking):, todo:, suggestion(blocking):} ∨ source(f)=recall`.

### Verdict

Verdict is computed from the complete deduplicated F and fails closed on blockers.

| Condition | Verdict |
|-----------|---------|
| ∃f ∈ F: blocks(f) | Request changes |
| Warnings only, no blockers | Approve with comments |
| Suggestions/praise only | Approve |
| F = ∅ | Approve (clean) |

### Render once

Build one `## Code Review` body in this order:

1. `## Spec` — render Σ from Phase 2, one row per criterion in σ order: `✓` met / `✗` missing, quoting `criterion_text`. σ ∄ → `no spec available — spec axis not evaluated`.
2. `## Standards` — the orchestrator reads `skill://dev-review/review-smells.md` once, walks Δ against the baseline, and emits at most one `possible <Smell>` row per smell. Render the receipt in `## Standards (judgement pass — {n} smells walked, {k} fired)`. These rows never enter F, carry `Class:`, or affect verdict.
3. Grouped findings from step 5. **Render every finding exactly once here.** Spec and Standards are roll-ups, never copies of a finding.
4. Roster allocation disclosures from step 6.
5. Summary + verdict.

**`/fix` partition (load-bearing):** `skill://fix` parses Conventional Comments from the whole body. Spec and Standards rows MUST be non-CC-shaped: no line in either block may match `^\s*[-*]?\s*(issue|suggestion|todo|nitpick|thought|question|praise)(\([a-z-]+\))?:`. Paraphrase a quoted σ or Δ line that matches this shape, or cite only its location. Never restate a grouped finding in either axis block. This preserves one fix task per finding and keeps review separate from fixing.

### Post the same body

1. Resolve PR# from the argument, else `gh pr list --head "$(git branch --show-current)" --json number --jq '.[0].number'`.
2. Create the body in a mktemp dir — never a fixed `/tmp` path:
   ```bash
   [[ "$PR" =~ ^[0-9]+$ ]] || { echo "Invalid PR number: $PR" >&2; exit 1; }
   TMPDIR=$(mktemp -d -t "omp-build-review-comment-PR${PR}-XXXXXX")
   trap 'rm -rf "$TMPDIR"' EXIT
   BODY="$TMPDIR/body.md"
   ```
3. Write the single rendered body to `"$BODY"`. PR ∃ → `gh pr comment "$PR" --body-file "$BODY"`. PR ∄ → render that body to the user and skip only the comment call.

**Comment shape (order normative, content illustrative):**

```markdown
## Code Review

## Spec
- ✓ "chunk count follows chunk files" — met
- ✗ "oracle warnings reach output" — missing (see Blockers)

## Standards (judgement pass — 12 smells walked, 1 fired)
- possible Feature Envy — `roster.ts:80` (judgement)

### Blockers
issue(blocking): oracle warnings dropped …

### Warnings
…

Roster capped by max_agents: R-devops

**Verdict: Request changes** — 1 blocking finding
```

**→ immediately continue to Phase 8.**

## Phase 8 — Next Step

Q:
- **Fix now** — invoke `skill://fix` (auto-apply + 1b1, applied inline; its Phase 8 offers rebase + label + merge)
- **Merge as-is** — rebase + label + auto-merge (below)
- **Stop** — exit

**If Merge as-is:**

1. `git fetch origin ${BASE} && git rev-list HEAD..origin/${BASE} --count`
   - count > 0 → `git rebase origin/${BASE}` + `git push --force-with-lease`
   - conflict → halt (¬label)
2. Q: "Add `reviewed` label?" → Yes / No
3. Yes → `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"` → auto-merge merges (merge commit, ¬squash) on green CI. ¬auto-merge workflow in repo → `gh pr merge <#> --auto --merge`. ¬plain `gh pr merge` while any check is IN_PROGRESS/QUEUED — mid-CI merge cancels in-flight runs + skips gates.
4. No → inform manual

> This skill ¬fixes code. Fixing = `skill://fix`.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| \|Δ\| = 0 | Halt |
| Binary ∈ Δ | Skip, note |
| \|Δ\| > 50 | Warn, suggest split |
| F = ∅ | Clean approve, post, Phase 8 |
| Critical security | Escalate in findings, flag in verdict |
| Agents disagree | Present both with respective C |
| ¬∃ PR | Render Phase 4 body; Phase 8 local only |
| Missing root cause/solutions | C(f) := 0; keep finding |
| ∄ `size:` label | τ := F-lite, disclosed out loud (never silently) |
| R-architect skipped | no axial or structural evidence |
| R-tester skipped | ¬delta_test_hit — that is the whole gate |
| R-security-auditor skipped | path_hit=false — R-adversarial owns OWASP on every review |
| FE/BE concern in Δ | R-adversarial floor owns it — the domain roles are cut, ¬spawn a substitute |
| Low-confidence finding | keep; sort by C and let `skill://fix` route it |
| Recall worker skipped | single chunk ∨ class appears in <2 chunks ∨ <3 unique callsites |
| roster capped (max_agents, per chunk) | disclosed when ≠ ∅ (Phase 4) |
| oracle warnings ≠ ∅ | echoed into output; review_halt → HALT |

## Safety Rules

1. Fresh agents only — ¬implementation context
2. ¬approve PRs on GitHub; ¬enable auto-merge outside the Phase 8 human decision (label gate)
3. Merge = merge commit only, ¬squash; merge executes via the gate (label + auto-merge), never manually mid-CI
4. ¬fix code — findings only. Fixing = `skill://fix`
5. ∃ PR → must post the Phase 4 body
6. Human decides at Phase 8 — ¬proceed without Q

## Chain Position

- **Phase:** Verify
- **Predecessor:** implement
- **Successor:** conditional — APPROVED → merge → cleanup | CHANGES_REQUESTED → `skill://fix`
- **Class:** verdict (branching based on findings)
- **Loop cap:** max 2 fix→review iterations. A 3rd review iteration → Phase 8 must recommend Merge as-is or Stop, not Fix.

$ARGUMENTS
