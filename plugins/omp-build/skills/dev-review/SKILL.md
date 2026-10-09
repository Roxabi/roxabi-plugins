---
name: dev-review
argument-hint: '[#PR]'
description: >-
  OMP-only multi-domain code review — five-role evidence-selected panel, Conventional Comments, common root causes, findings + verdict.
  Triggers: "dev-review" | "code review" | "review changes" | "review PR #42" | "check my code" | "review my changes" | "review this PR" | "do a code review" | "review the diff".
  Not the host native /review, not Matt code-review.
version: 0.1.0
---

# Code Review

## Success

I := F collected ∧ R named ∧ verdict posted (PR ∃) ∧ Phase 8 decision made ∧ (PR ∃ → the posted line 2 is the pre-post `REVIEWED_HEAD` snapshot, and the post-time `headRefOid` equals that snapshot; a different head is not posted)
V := `gh pr view {N} --comments | grep "## Code Review"` ∧ verdict ∈ {Approve, Request changes} ∧ the posted line 2 is `<!-- omp-build:review-head sha=<40 lowercase hex> -->` of that snapshot. A post-time `headRefOid` that differs → do not post.

Review branch/PR via fresh agents → Conventional Comments → root causes → findings + verdict.

**⚠ Flow: single continuous pipeline (Phases 1→4 + 8). ¬stop between phases. Decision response → immediately execute next phase. Stop only on: |Δ|=0, explicit Cancel, roster `review_halt`, or Phase 8 completion.**

```
/skill:dev-review          → snapshot `git rev-parse HEAD`, then diff origin/${BASE}...HEAD  (BASE = staging|main|master, first that exists)
/skill:dev-review #42      → snapshot `gh pr view 42 --json headRefOid` before `gh pr diff 42`. Do not post if a re-read differs.
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
| 4 | merge-render-post | ✓ | F + R + verdict (+ PR comment when PR ∃) | dedup → name causes → render once → verdict → post |
| 8 | next-step | ✓ | decision made | — |

## Pre-flight

Success: F collected ∧ R named ∧ verdict posted ∧ Phase 8 decision made ∧ (PR ∃ → posted line 2 is the pre-post snapshot, and a different post-time head is not posted)
Evidence: `gh pr view {N} --comments | grep "## Code Review"` ∧ posted line 2 is the snapshot sha
Steps: gather-changes → secret-scan → spec-compliance → multi-domain-review → merge-render-post → next-step
¬clear → STOP + ask: "Which branch/PR to review?"

## Phase 1 — Gather Changes

0. **Bind the review and disarm it before gathering or posting anything.** Every
   review of a PR runs this step — nested `/feature` (§6.4, for a new PR and for
   an `existing` one resumed in §6.0) and standalone alike. Nested `/feature`
   supplies its numeric `pr` as `explicitPr`; `resolveReviewPr` returns it with
   no `gh` call. Standalone resolves the argument or current branch exactly once:

   ```javascript
   const { pathToFileURL } = await import('node:url')
   const { join } = await import('node:path')
   const { resolveReviewPr, nextReviewStep, landPr, applyCiWatchExit } =
     await import(pathToFileURL(join(SKILL_DIR, '../feature/workflow.js')).href)
   const pr = await resolveReviewPr(cwd, explicitPr)
   if (pr !== null && (await nextReviewStep(cwd, pr, { reviewing: true })).action === 'stop') {
     // The bound is spent and the step disarmed an armed gate: display the
     // Phase 8 dossier and stop before reviewing.
     return
   }
   ```

   `explicitPr` is the optional positive argument, else undefined. `pr === null`
   is a local-only review: no PR, no bound, nothing to land. `reviewing` disarms
   an armed gate whatever the step, `land` included, before the review reads
   the diff (the armed gate, Phase 8); an approving post re-arms through `landPr`
   in Phase 8. Any throw from `resolveReviewPr` or `nextReviewStep` stops the
   review and is reported — the gate may still be armed, and a disarm that failed
   names what stays armed. Never fall back to local, never review on. Keep this
   one `pr` through all phases and rounds.
1. Source the shared helpers. `skill://` rejects `..`, so `lib.sh` (one level up, outside any skill directory) is reachable only from a real path — and an unset `SKILL_DIR` would silently make that path `/../shared/lib.sh`, i.e. a base branch detected against nothing:

   ```bash
   SKILL_DIR="${SKILL_DIR:?dev-review Phase 1: skill directory not announced — export SKILL_DIR to this skill's directory and re-run}"
   BASE=$(. "$SKILL_DIR/../shared/lib.sh" && detect_base_branch)
   ```
2. When a PR is bound, snapshot the reviewed commit before any diff: `REVIEWED_HEAD=$(gh pr view "$PR" --json headRefOid --jq .headRefOid)`, then diff that PR (`gh pr diff "$PR"`), never the local tree. Do not `git diff` the worktree. A local-only review (no PR bound) snapshots `git rev-parse HEAD`, diffs `git diff origin/${BASE}...HEAD`, and posts no head line. Re-read the snapshotted oid immediately after the diff. If it differs, discard the diff and stop: the head moved, re-run the review. Do not judge a diff whose commit is not the snapshot.
3. Δ names come from that same diff. A bound PR uses `gh pr diff "$PR" --name-only`, never `git diff` of the local tree. A local-only review uses `git diff --name-only origin/${BASE}...HEAD`.
4. ∀ f ∈ Δ: read the file body from the snapshot — `git show "$REVIEWED_HEAD:$f"` when a PR is bound, the worktree file only when no PR is bound. Never the worktree when a PR is bound. Skip binaries, note.
5. |Δ| = 0 → halt
6. |Δ| > 50 → warn, suggest split

## Phase 1.5 — Secret Scan

The scan reads the diff step 2 judged. A bound PR pipes `gh pr diff "$PR"`; a local-only review pipes `git diff origin/${BASE}...HEAD`.

```bash
# bound PR — never `git diff` of the local tree
gh pr diff "$PR" | grep -iE '(password|passwd|secret|api[_-]?key|auth[_-]?token|access[_-]?token|private[_-]?key)\s*[:=]\s*["\x27`][^"\x27`]{8,}' | head -20
# local-only review
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
   - bound `pr` from Phase 1 → `gh pr view PR --json body,headRefName` → `(Fixes|Closes|Resolves) #(\d+)` in body; else first `N` from `<type>/{N}-*` in `headRefName`
   - else current branch → `<type>/{N}-*` match; else first `\d+` run (warn: legacy branch fallback)
2. **σ is the tracker issue body** (ADR-020 §4) — `gh issue view {issue_num} --json body --jq .body`. There is no `artifacts/specs` on OMP: ¬glob for one, ¬read frontmatter for `status`, ¬gate on `validated`.
3. σ ∄ (no issue resolved) → skip steps 4–4a; path-only roster.
4. σ ∃ → ∀ criterion: met → ∅ | ¬met → `issue(blocking):` | ∀ met → `praise:`
4a. **Retain Σ (review-output display input, ¬a finding source):** Σ := [{criterion_text, verdict ∈ {met, missing}}] ∀ criterion — a **mirror of step 4**, same binary call, ¬a second judgement. `criterion_text` is the σ line already read in step 4 (verbatim, trimmed); `missing` ⟺ step 4 emitted `issue(blocking):` for that criterion. ¬`ac_id` (no AC-numbering scheme exists — a positional id would be fabricated), ¬`partial`, ¬scope-creep set: none has a producer in steps 1–4, and an unproduced row is an invented one. Σ carries ¬label, ¬C, ¬class: it adds no blocker and ¬enters F.
5. SC→Test matrix (τ≠S): matrix ∃ in PR body → verify no silent gaps (every SC has a row), NO TEST reasons ∈ `{infra-not-wired, prompt-logic-only, ui-manual-only, out-of-scope}` enum. ¬matrix ∧ τ≠S → `issue(blocking):` missing SC→Test matrix.
In a repo with `.semctx/`, that matrix is the proof section `/feature` generated
from the closed change contract. The issue body remains the spec if they diverge.
5a. **UI proof.** When Δ touches `frontend.path` or `shared.ui` and `.dev/stack.yml` declares `commands.test_e2e`, a `ui-manual-only` row is an `issue(blocking):` — the e2e command is the proof, not a hand check. Without an e2e command, `ui-manual-only` is legal only when the PR body records an agent browser check: steps, URL, observed result. The NO TEST enum itself is unchanged.

A finding emitted in steps 4–5a whose only gap is a missing or weak test is not finally labelled in this phase. Phase 4 step 3b rewrites that label. A missing SC→Test matrix stays `issue(blocking):`. An unmet criterion whose gap is the behaviour itself, not the test, stays `issue(blocking):`.

For every Phase 2 finding, the orchestrator emits the finding format below with its actual agent identity and `Provenance: [{agent: <actual emitter>, phase: spec, callsites: [<cited and evidenced raw locations>], source: <original Source when present>}]`. No chunk is invented for spec findings.

### τ comes from the `size:` label — nothing else

```bash
RAW=$(gh issue view "$issue_num" --json labels \
  --jq '[.labels[].name | select(startswith("size:"))][0] // empty' | sed 's/^size://')
RAW=$(printf '%s' "$RAW" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
case "$(printf '%s' "$RAW" | tr '[:upper:]' '[:lower:]')" in
  '' ) TIER=F-lite; echo "no size: label on #$issue_num — review tier defaults to F-lite" ;;
  s|xs) TIER=S ;;
  m|f-lite) TIER=F-lite ;;
  l|xl|f-full) TIER=F-full ;;
  *) TIER=F-lite; echo "size: label '$RAW' on #$issue_num is not canonical — review tier defaults to F-lite" ;;
esac
```

`docs/agents/issue-tracker.md` § Labels: the `size:` label is the **only** source of τ. With spec frontmatter gone (ADR-020 §4), there is no second place to look — ¬infer τ from |Δ|, ¬from the issue title, ¬from a spec file.

∄ label ∨ ∄ issue_num → τ := `F-lite` **and say so out loud**: "no `size:` label on #N — review tier defaults to F-lite". A silent default is the failure `issue-triage` exists to prevent. A legacy or spaced value (`M`, ` M`, `XS`, `L`, `XL`) is mapped (`M` → F-lite); anything else is F-lite, said out loud.

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
T=$(realpath skill://dev-review/roster.sh) || {
  printf 'REFUSE: cannot resolve skill://dev-review/roster.sh\n'
  exit 1
}
bash "$T" \
  --diff-list "$REVIEW_TMP/delta.txt" \
  --tier "$TIER" \
  --chunks "$CHUNKS" \
  [--spec "$REVIEW_TMP/spec.md"] \
  --json
# multi-chunk — repeat --chunk-list for every chunk
printf '%s\n' "${CHUNK_I_FILES[@]}" > "$REVIEW_TMP/chunk_${i}.txt"
T=$(realpath skill://dev-review/roster.sh) || {
  printf 'REFUSE: cannot resolve skill://dev-review/roster.sh\n'
  exit 1
}
bash "$T" \
  --diff-list "$REVIEW_TMP/delta.txt" \
  --chunk-list "$REVIEW_TMP/chunk_0.txt" \
  --chunk-list "$REVIEW_TMP/chunk_1.txt" \
  --tier "$TIER" \
  [--spec "$REVIEW_TMP/spec.md"] \
  --json
```

**R-tester gate:** `delta_test_hit` or `untested-change`. Changed-test evidence in Δ arms the role. So does a source change with no test file, except at size S. There is no second round-trip: the executable falsify oracle is cut on OMP (ADR-020 §8), so no `--oracle-ok`, no `run-falsify.sh --verify`, no `oracle_ok` field to read and no coverage-gap disclosure to make when it is absent.

Exit: `0` ok · `1` usage/IO error (including unreadable `--spec` or empty `--chunk-list`) · `2` σ priced-fence hygiene (emit the spec-hygiene `issue(blocking):`; JSON remains on stdout). `claims` and `priced_claim_ok` report that hygiene check only and never gate a spawn.

### Agent dispatch

| Agent | Evidence gate | Focus |
|-------|---------------|-------|
| **R-adversarial** | **always; floor in every chunk** | bypass, fleet regression, vacuous guards, assumption-kill + OWASP lens |
| **R-security-auditor** | strong auth/secrets/crypto path or diff evidence (`path_hit`, including `**/auth/**`) | OWASP, secrets, injection, auth |
| **R-architect** | axial ADR + root axial path → axial mode; otherwise architecture/ADR path, workspace graph config, or configured FE+BE crossing → structural mode | axial N×M drift, boundaries, coupling, circular dependencies |
| **R-devops** | infra/config/deploy evidence such as `scripts/`, `.github/`, or `lefthook.yml` | config, deploy, infra |
| **R-tester** | `delta_test_hit` or `untested-change` — changed tests, or source with no test file | coverage, AAA, edge cases, tautology |

Five roles, and that is the whole panel: the oracle selects at most two specialists after the floor unless forced overrides bypass the cap. There is **no** `R-frontend-dev` and **no** `R-backend-dev` here — both are cut (ADR-020 §7), and component, hook, client-behaviour, API, contract and error concerns fall to the `R-adversarial` floor through the sibling-drop rule, which keys off the `Spawned roster:` line in the prompt below. Nothing replaces them; a domain-heavy diff simply gets the floor plus whatever evidence actually fired. Likewise **no** `R-fixer`: `skill://fix` applies findings inline.

Architect requires axial or structural evidence; F-full alone is cold. Axial mode requires an axial ADR (`axial: true` under `docs/architecture/adr/`) plus a root axial path in Δ (`infrastructure/`, `adapters/`, `domains/`, or `stages/`) and also covers read-only structural architecture concerns in that assigned chunk. Structural mode requires an architecture/ADR path, a workspace graph config, or a diff crossing the `frontend.path`/`backend.path` roots configured in `.dev/stack.yml` — that crossing is an architecture signal, not a domain-role gate, and it survives the cut of the domain roles.

Skip: tester → ¬`delta_test_hit` ∧ ¬`untested-change` (source files, no tests, τ ≠ S) | devops → no infra evidence | architect → no axial/structural evidence | security → `¬spawn_security_auditor`.

**One gate reads τ.** `R-tester`'s `untested-change` disjunct is cold at `S` and arms otherwise. Every other row fires on Δ, the stack overrides and the axial ADR alone. The tier is still echoed back in the JSON and consumed by Phase 2. A gate described as tier-selected for any other role would be describing a branch that does not exist.

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
# CROSS-SKILL CONSUMER: fix/SKILL.md Phase 0 reads this YAML via `skill://dev-review/review-classes.yml`, and fix Phase 2 reads `skill://dev-review/root-causes.md` — moving or renaming either HALTs /fix

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
      task: "Code review task. Focus: {focus}.\n\nSpawned roster (this review): {agents[]}. Sibling-drop rules key off THIS list — a concern whose owner is ¬in the list is YOURS: keep the finding. This panel has five roles and two of them are specialists picked by evidence, so component/hook/client-behaviour and API/contract/error concerns usually have ¬owner: they are yours. If you are R-adversarial: also apply an OWASP lens (secrets, injection, auth); the default panel is R-adversarial alone, so spec-scope, structure and coverage φ are yours unless the roster names R-architect/R-tester (R-product-lead is ¬in the roster at all — Phase 2 owns spec compliance). Output Conventional Comments findings only. ¬spawn agents (¬task, ¬Skill). ¬invoke this skill. Review your assigned scope yourself.\n\nYou are reviewing chunk {i} of {N}. Review ONLY the files in this chunk.\n\nAdditionally audit each chunk against the systematic blind spots in `skill://dev-review/review-blind-spots.md` — call out each applicable one explicitly (or note none apply).\n\nFormat per finding:\n<label>: <description>\n  <file>:<line>\n  -- {agent}\n  Provenance: [{agent: {agent}, phase: panel, chunk: {i}, source: <original Source when present>, callsites: [<this report's evidenced locations>]}]\n  Root cause: <why>\n  Symptoms/evidence: <observed failure and supporting evidence>\n  Class: [<canonical-class>, ...] [candidate/<slug>?]  ← 0–N canonical from review-classes.yml + 0–1 candidate; omit field if no class applies\n  Raw callsites: [{file: <path>, line: <n>}, ...]  ← all evidenced manifestations of this defect; required when Class is set; never empty; classless explicit lists permitted\n  Solutions:\n    1. <primary> (recommended)\n    2. <alternative>\n  Confidence: N%\n\nAgent and chunk above are actual orchestrator task context. Omit unknown optional provenance values; retain original Source and extensions such as Lens/Attack/disproof. A class-wide discovery list is not this finding's callsite list.\n\nCanonical classes (use slug only): test-tautology, generator-drift, parallel-path-drift, bash-arithmetic-trap, bash-error-suppression, target-axis-trap, vacuous-guard, shell-injection, sql-injection, missing-error-handling, missing-input-validation, secret-leak, bare-except, path-traversal, unbounded-loop. Free-text labels not in this list or candidate/* namespace are invalid. Candidate slugs must match ^candidate/[a-z][a-z0-9-]{1,48}$. Subsumption: bare-except subsumes missing-error-handling — when both apply, tag bare-except only; strip tags within a finding, never merge findings. parallel-path-drift and target-axis-trap are siblings (¬overlap) — parallel-path-drift for security hardening missing on a sibling entry point, target-axis-trap for architectural concern duplication across the non-primary axis (concern copy-pasted in ≥3 sibling dirs); prefer the matching one, do not double-tag.\n\n---CHUNK DIFF (chunk {i})---\n{c_i.hunk_text for all files in chunk}\n\n---CHUNK FILES---\n{contents of files in c_i}\n\n---BOUNDARY DIGESTS (other chunks)---\n{format_digest_for_agent(d) for d in digests if d.chunk_index != i}\n\n---SPEC---\n{σ body if ∃, else omit section}"
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
class_index = {}   # class_slug → {chunks: set[int], callsites: set[{file, line}], reports: list}

∀ chunk c_i, ∀ finding f with class[] ≠ []:
  ∀ cls in f.class[] where ¬cls.startswith("candidate/"):
    class_index[cls].chunks.add(i)
    class_index[cls].callsites.update(f.raw_callsites)
    class_index[cls].reports.append({finding: f, provenance: f.provenance,
                                    callsites: f.raw_callsites})
```

`candidate/*` classes never join and never trigger recall.

`chunks` and unique `callsites` are scheduling sets only. `reports` retains each original finding's description, root cause, symptoms/evidence, solutions, confidence, emitter, phase, chunk and original Source, with its own report-to-callsite associations. Preserve distinct reports at a shared location; the class index does not merge defects.

**Step 2 — Trigger per class only when all hold:**

```
|chunks| > 1
cls is canonical
|class_index[cls].chunks| ≥ 2
|class_index[cls].callsites| ≥ 3
```

There is no diff-size or confidence knob. A single-chunk concentration never triggers recall.

**Step 3 — Spawn one isolated worker per triggered class:**

Before dispatch, the orchestrator sets `finding_format` to the verbatim fenced template in § Finding format below and expands `{finding_format}` into the task text. Pass only that template, not this skill's full body or implementation context; the worker does not invoke a skill. Confidence uses the shared integer 0–100 rule.

```
task(
  context: "Cross-chunk recall for {PR#|branch}. Read-only; no implementation context.",
  tasks: [
    {
      name: "Recall{cls}",
      agent: "scout",
      task: "Fresh isolated read-only recall for canonical class '{cls}'.\n\nInput only:\n  class: {cls}\n  callsites: {class_index[cls].callsites}\n  reports: {class_index[cls].reports}\n  context_lines: 10\n  cross_chunk_index: {chunks: {class_index[cls].chunks}, agents: {agents_that_flagged}}\n\nAuthoritative finding format (expanded by orchestrator):\n{finding_format}\n\nEmit each finding in exactly that shape, including the standalone file:line citation and all mandatory fields. Confidence is an integer from 0 through 100 followed by %, not confidence-band prose.\n\nProcedure:\n1. RC-3 scope confirmation: read only ±10 lines around every supplied callsite and confirm every sibling entry point is covered. Check each input report's diagnostic mechanism independently, including distinct mechanisms at the same seed location; a confirmed class/location does not confirm every report there.\n2. RC-6 uncited-instance search: use read-only search for structural siblings of the flagged pattern (same signature shape, import, or decorator).\n3. Emit separate Conventional Comments findings for independently confirmed mechanisms, including co-located ones. Group locations within a finding only when evidence demonstrates the same defect. Use label `issue(blocking):`, active `Source: recall`, agent scout and canonical Class '{cls}' in the authoritative format. Record actual emitter scout, phase recall, original Source recall, and the locations this worker evidenced; include chunk only when actually known. Retain input-report provenance only for the mechanism and seed callsites that report actually supports. New locations have observed scout/recall provenance only, never inherited seed provenance. Preserve all confirmed input symptoms/evidence and their original source associations, including Lens/Attack/disproof extensions; do not copy the whole class index's agents/chunks onto a finding.\n4. If no additional or confirmable instance exists, return a plain scope receipt, not a finding.\n\nRead-only: read/grep/glob only. No write, edit, bash, task, Skill, tests, implementation context, or full diff. Never invent a callsite. Never spawn another worker or invoke this skill."
    }
  ]
)
```

Workers run in parallel. Collect their findings into Phase 4. A missing or weak test among them is not finally labelled until Phase 4 step 3b. The worker's `Source: recall` is an emission mark, not an input to `blocks(f)` after that step. Single-chunk reviews skip this recall phase, not that rewrite.

### Review dimensions
correctness | security | performance | architecture | tests | readability | observability

### Finding format (ALL fields mandatory except Class/Raw callsites and conditional detail)

```
<label>: <description>
  <file>:<line>
  -- <agent>
  Provenance: [{agent: <original emitter>, phase: <spec|panel|recall>, chunk: <index when known>, source: <original Source when present>, callsites: [{file: <path>, line: <n>}, ...]}, ...]
  Root cause: <why, not what>
  Symptoms/evidence: <observed failure and supporting evidence; retain distinct details>
  Class: [<canonical-class>, ...] [candidate/<slug>?]
  Raw callsites: [{file: <path>, line: <n>}, ...]
  Solutions:
    1. <primary> (recommended)
    2. <alternative>
    3. <alternative> [optional]
  Confidence: <integer 0-100>%
```

Provenance is immutable emission history, not an impact label. Keep each tuple's emitter/phase/chunk/original Source associated with the locations that report actually evidenced; omit unknown optional values, never fabricate them. The `-- <agent>` line remains mandatory; a merged record may list all emitters there. Preserve any report extensions (including Lens and Attack/disproof) in the same finding.

**Class field rules:**
- 0–N canonical tags from `skill://dev-review/review-classes.yml` + 0–1 `candidate/<slug>` tag
- Omit the `Class:` field entirely when no class applies (¬write `Class: []`)
- Free-text labels not in the canonical list and not prefixed `candidate/` → invalid; treat as C(f) := 0
- `candidate/<slug>` must match `^candidate/[a-z][a-z0-9-]{1,48}$`; slug violating format → invalid, C(f) := 0
- `Raw callsites` required when `Class` is set; list ALL evidenced manifestations of this defect in the diff + resolved imports, never just the cited line; format: `[{file: <path>, line: <n>}, ...]`. Classless findings may emit explicit Raw callsites, which remain authoritative member locations. A class-wide discovery list is not a finding's callsite list.
- Subsumption: `bare-except` subsumes `missing-error-handling` — when both could apply, tag `bare-except` only. Strip tags within a finding, never merge findings.
- Subsumption: `parallel-path-drift` ⊥ `target-axis-trap` (siblings, ¬overlap). Authoritative definition + threshold (≥3 sibling dirs) lives in `review-classes.yml` RC-3 and RC-5 — see the `note:` fields there. Tag exactly one; do not double-tag.

C(f) = min(diagnostic_certainty, fix_certainty)

| Band | C | Criteria |
|------|---|----------|
| Certain | 90-100 | Unambiguous diagnosis + fix |
| High | 70-89 | Clear diagnosis, 1-2 approaches |
| Moderate | 40-69 | Probable, context-dependent |
| Low | 0-39 | Speculative, competing explanations |

**Validation:** missing mandatory fields ∨ C ∉ ℤ ∩ [0,100] ∨ free-text class label → C(f) := 0 (kept; `skill://fix` files a cause with a C := 0 member instead of applying it).

### Finding categories

| Category | Label | Blocks? |
|----------|-------|:---:|
| Bug / Security / Spec gap | `issue:` / `todo:` | ✓ |
| Standard violation | `suggestion(blocking):` | ✓ |
| Style | `suggestion(non-blocking):` / `nitpick:` | ✗ |
| Architecture | `thought:` / `question:` | ✗ |
| Good work | `praise:` | ✗ |

**Missing or weak test.** A missing test, a test that still passes when the guard is removed, a tautology, or a coverage gap is blocking only when the behaviour it leaves unproven is an acceptance criterion of the issue with no other evidence in the PR, or a safety invariant: a path that merges, releases or deploys, deletes, publishes, grants permission, or stops or disarms an automated action. Otherwise the label is `suggestion:`, which does not satisfy `blocks(f)`.

Label → group, matched exactly (do not prefix-match `suggestion:` onto `suggestion(blocking):`):

| Group | Labels |
|-------|--------|
| Blockers | `issue:`, `issue(blocking):`, `todo:`, `suggestion(blocking):` |
| Warnings | `suggestion:`, `suggestion(non-blocking):`, `nitpick:` |
| Suggestions | `thought:`, `question:` |
| Praise | `praise:` |

## Phase 4 — Merge, Render & Post

One phase owns the final finding set, the single rendered review, and the optional PR comment. Findings are never re-rendered in a second presentation step.

1. **Collect F** from Phase 2 spec compliance, per-chunk agents, and isolated recall workers. Every unmet criterion's `issue(blocking):` enters F so a missing spec criterion cannot coexist with `Approve (clean)`. A missing or weak test that step 3b rewrites to `suggestion:` is a Warning: it does not by itself force `Request changes`, and it does not yield `Approve (clean)`.
   Validate each original report independently with the finding-format rules before merging. Capture its provenance from the actual emission/task context before any fields can be combined; validation-zero records stay independently identifiable in F.
2. **Same-defect-only merge:** merge reports only when their evidence demonstrates the same failing operation/condition and diagnostic mechanism. Shared file, class, line, citation or similar wording is metadata, not identity. Independently falsifiable failures stay separate; uncertain identity stays separate. Different symptoms merge only when the evidence demonstrates that one defect produces them.
   - Union every unique symptom, evidence sentence, raw callsite, solution, provenance tuple and report extension (including Lens and Attack/disproof). Keep report-to-callsite provenance associations, not Cartesian unions of agents and locations. Retain every original symptom/description in the detail when the final description changes.
   - Maximum valid confidence orders merged duplicates; it does not choose which details survive. Preserve a blocking label if any duplicate is blocking until the existing final step 3b rewrite. Retain active `Source: recall` when any duplicate has it for step 3; original Sources remain in provenance independently.
   - Validation-zero/malformed reports remain separate, unhealed by another report's fields or confidence. Class subsumption strips tags only. No extra LLM pass, confidence filter, file/class/location key or second joiner.
3. **Classify:** normal findings follow their category label. Before step 3b, a finding with `Source: recall` is normalized to `issue(blocking):`. That normalization is not re-applied after step 3b. A surviving `Source: recall` line does not restore a blocking label.
3b. **Missing or weak test — last label write.** After collection, dedup, and the recall normalization, before the verdict and before root causes, rewrite a finding whose subject is a missing or weak test. That includes an agent `issue:`, a recall finding (the recall worker's required `issue(blocking):` is not final), and a Phase 2 unmet-criterion finding whose only gap is that test. It does not include a missing SC→Test matrix, and it does not include an unmet criterion whose gap is the behaviour itself. Keep the finding. It stays blocking, labelled `issue:`, only when the behaviour it leaves unproven is an acceptance criterion of the issue with no other evidence in the PR, or a safety invariant (a path that merges, releases or deploys, deletes, publishes, grants permission, or stops or disarms an automated action). Otherwise relabel it `suggestion:`. Clear `Source: recall` when it is present. That relabel is the last label write. A surviving `Source: recall` line does not re-enter `blocks(f)`. After this step `blocks(f)` is the label set only, so a downgraded finding does not block whether or not that line survived.
4. **Keep by default:** after same-defect-only merge, every finding remains in F. Confidence controls ordering. A validation zero (C := 0) also makes the finding's cause ineligible for auto-apply in `skill://fix`. No confidence threshold, agent judgement, or second LLM pass may remove a finding. Blocking findings are never filtered.
5. **Sort and group:** C descending within Blockers → Warnings → Suggestions → Praise, using the label → group table above. `suggestion:` is a Warning, not a Suggestion.
   Finalize each rendered description before naming causes. Distinct findings sharing an anchor get distinct mechanism-specific descriptions; retain their original symptoms/evidence in the finding. Cause references use those exact final descriptions.
6. **Name root causes.** Read `skill://dev-review/root-causes.md`. R := causes over actionable findings, after reading cited lines where a join is not already obvious. praise, thought, question never enter R. This step writes no code.
7. **Disclose roster allocation** in the review output whenever non-empty: `capped[]` (the per-chunk union) and `warnings[]`.

`blocks(f) := label ∈ {issue:, issue(blocking):, todo:, suggestion(blocking):}`. Evaluated after step 3b. After step 3b, `blocks(f)` is the label set only. A downgraded finding does not block whether or not a `Source: recall` line survived.

### Verdict

Verdict is computed from the complete deduplicated F and fails closed on blockers.

| Condition | Verdict |
|-----------|---------|
| ∃f ∈ F: blocks(f) | Request changes |
| Warnings only, no blockers | Approve with comments |
| Suggestions/praise only | Approve |
| F = ∅ | Approve (clean) |

No blocker and Warnings nonempty → `Approve with comments`, even when praise, thought, or question are also present. Those do not demote the verdict to `Approve`, and they do not make it `Request changes`. The four rows above are unchanged. Round accounting is unchanged: only `Request changes` is red.

### Render once

Build one body. Its first line is exactly `<!-- omp-build:code-review -->`: that marker is how `skill://fix` finds the record, together with the comment author. When a PR exists, line 2 is exactly `<!-- omp-build:review-head sha=<40 lowercase hex> -->` naming the Phase 1 `REVIEWED_HEAD` snapshot, never a fresh read and never a worktree oid. Immediately before `gh pr comment`, re-read `headRefOid`. If it differs from `REVIEWED_HEAD`, do not post — not an approval, not a request for changes, and not a head line for the new oid. Stop and say the head moved; the review has to be re-run against the new commit. A sha anywhere else is not the reviewed commit. A local-only body has no line 2. Then, in this order:

1. `## Code Review`, then `## Spec` — render Σ from Phase 2, one row per criterion in σ order: `✓` met / `✗` missing, quoting `criterion_text`. σ ∄ → `no spec available — spec axis not evaluated`.
2. `## Standards` — the orchestrator reads `skill://dev-review/review-smells.md` once, walks Δ against the baseline, and emits at most one `possible <Smell>` row per smell. Render the receipt in `## Standards (judgement pass — {n} smells walked, {k} fired)`. These rows never enter F, carry `Class:`, or affect verdict.
3. `## Root causes` — render R from step 6, in the shape `skill://dev-review/root-causes.md` defines. R = ∅ → the section body is exactly `none`, even when actionable findings remain uncited. This declares no named causes, not no actionable findings.
4. `## Findings` — this heading closes `## Root causes`. Grouped findings from step 5 under `### Blockers`, `### Warnings`, `### Suggestions`, `### Praise`. **Render every finding exactly once here**, with all unioned detail and immutable provenance. Build cause citations from the final rendered `file:line` + exact description pairs. Every reference resolves to exactly one finding, and each actionable finding belongs to at most one cause; otherwise retain it for the existing uncited/per-finding file/single-deferral disposition. Spec, Standards, and Root causes are roll-ups, never copies of a finding.
5. Roster allocation disclosures from step 7.
6. Summary + verdict.

**`/fix` partition (load-bearing):** `skill://fix` reads only the newest comment whose first line is the marker and whose author is the account running it. From that one comment it takes R from `## Root causes` (up to `## Findings`) and F from the Conventional Comments under `## Findings`. Spec, Standards, and Root causes rows MUST be non-CC-shaped: no line in those blocks may match `^\s*[-*]?\s*(issue|suggestion|todo|nitpick|thought|question|praise)(\([a-z-]+\))?:`. Paraphrase a quoted σ or Δ line that matches this shape, or cite only its location. Never restate a grouped finding in any of those blocks.

### Post the same body

1. Reuse the `pr` bound in Phase 1 (or supplied by `/feature`). No rediscovery.
2. Create the body in a mktemp dir — never a fixed `/tmp` path:
   ```bash
   # PR exists: validate the bound number before posting. No PR: display locally.
   [[ "$PR" =~ ^[0-9]+$ ]] || { echo "Invalid PR number: $PR" >&2; exit 1; }
   TMPDIR=$(mktemp -d -t "omp-build-review-comment-PR${PR}-XXXXXX")
   trap 'rm -rf "$TMPDIR"' EXIT
   BODY="$TMPDIR/body.md"
   ```
3. Write the single rendered body to `"$BODY"`. PR ∃ → `gh pr comment "$PR" --body-file "$BODY"`. PR ∄ → render that body to the user and skip only the comment call.

**Comment shape (order normative, content illustrative):**

```markdown
<!-- omp-build:code-review -->
<!-- omp-build:review-head sha=0123456789abcdef0123456789abcdef01234567 -->
## Code Review

## Spec
- ✓ "chunk count follows chunk files" — met
- ✗ "oracle warnings reach output" — missing (see Blockers)

## Standards (judgement pass — 12 smells walked, 1 fired)
- possible Feature Envy — `roster.ts:80` (judgement)

## Root causes

### RC-1 — warnings dropped before the comment is posted
- mechanism: the render path keeps the verdict and drops the warning list
- fix: emit every roster warning into the posted body
- findings: `skills/dev-review/SKILL.md:350` — oracle warnings dropped before posting

## Findings

### Blockers
issue(blocking): oracle warnings dropped before posting
  skills/dev-review/SKILL.md:350
  -- orchestrator
  Provenance: [{agent: orchestrator, phase: spec, callsites: [{file: skills/dev-review/SKILL.md, line: 350}]}]
  Root cause: the render path drops the warning list
  Symptoms/evidence: the posted body omits the supplied oracle warning
  Solutions:
    1. Emit every roster warning into the posted body (recommended)
    2. Render warnings from the roster result directly
  Confidence: 95%

### Warnings
…

Roster capped by max_agents: R-devops

**Verdict: Request changes** — 1 blocking finding
```

`landPr` arms only when that line 2 names the PR's current `headRefOid`. A record with no head line does not arm: PRs reviewed before this line existed need one re-review. Native auto-merge is pinned with `--match-head-commit` of that sha. Merge-on-green is label-driven: a push by another actor after `reviewed` is applied is not refused by GitHub.

**→ immediately continue to Phase 8.**

## Phase 8 — Next Step (canonical escalation)

This section is the single escalation contract. `/feature` §6.6 and `skill://fix`
point here; do not invent a parallel stop policy.

**Called by `/feature`:** return the posted verdict and `REVIEWED_HEAD` to
`skill://feature` §6.4 before presenting this decision. That caller derives the
step and owns the fix and landing actions. Skip the standalone actions below;
never choose on the operator's behalf.

**Standalone review:** with a PR, derive the step from the post:
`step = await nextReviewStep(cwd, pr, { posted: { verdict, head: REVIEWED_HEAD } })`,
`verdict` as posted (`Request changes`, `Approve`, `Approve (clean)`,
`Approve with comments`). It throws when the latest review record is not this
post: report and stop. Local-only (no PR): `Request changes` → `fix`; an
approval ends the review, with nothing to land. There is no local bound.

**The bound (`workflow.js`, #710).** Two reads of the PR's review records by the
automation login: how many there are, and the latest one. A fix is allowed while
the PR has at most two records, one fix per review: the fix's push moves the
head, and a latest record of another commit asks for a review first (`review`).
A record past the second that does not approve spends the bound for good — a
later green does not lift it. A CI failure after the third review stops too.

**The armed gate (#713).** An OPEN PR is armed — `reviewed` label or auto-merge
enabled — only when the latest review record approves the current head, the bound
is not spent, and no review of that head is running. The four workflow exits share
`enforceArmedGate` (#729); `reviewing` is the actual review-running input, separate
from forced-unarmed policy. `disarmGate` is its clearing primitive: disable
auto-merge first, attempt label removal independently, validate read-back, and
throw one error naming any remainder. `disarmed: true` comes only from an attempted
clear with confirmed read-back, never an already-clear or non-OPEN no-op.
Every `nextReviewStep` action passes the policy; non-`land` actions and
`{ reviewing: true }` force clearing. A refused `posted` / `ciFailed` keeps an
armed gate only with refreshed approval/head evidence. `landPr` refusals, watch
failures 1–3 and pre-push barriers force clearing; those watch/push paths need no
review-service reads. Observer watch statuses retain only currently authorized
arms. Native `no-required-checks` also clears at an approved head: API discovery
failure cancels a scheduled merge on purpose, with no automatic restoration.
Native legacy stuck results adapt the same clearing error without retrying it. A
refused native pin with an unreadable head forces the known gate clear and throws the
original read error; a failed clear throws naming the remainder, with that cause. A
readable stable-head refusal stays `auto-merge-failed` / `armed: false` (no receipt).
`landPr` arms only within the bound. Nothing writes accounting; every step is
derived again from fresh reads.

### Human choice (constrained by `step`)

- **`fix`** → Q: **Fix now** / **Stop**. Fix now → for a review fix, run
  `skill://fix #<pr>` (omit `#<pr>` for local-only). For `step.reason === 'ci-failed'`,
  follow `/feature` §6.5's inline CI correction from failed-check logs, not the
  previous review. Then re-review. **Stop** exits; the records still allow that fix.
- **`land`** → Q: **Merge** / **Stop**. Merge → obtain explicit approval if needed,
  then follow **`skill://feature` §6.7 in full**: `landPr` (sole writer of `reviewed`;
  no raw label shortcuts), run the returned `watch`, map exits with
  `applyCiWatchExit`, and on `ci-failed` continue from
  `nextReviewStep(cwd, pr, { ciFailed: true })`. Never merge with residual
  blockers. Warnings-only is ordinary gated landing.
- **`review`** → the latest record does not review the current head: review again.
  The step already disarmed an armed PR.
- **`stop`** → no Fix, no Merge. Publish/display the escalation dossier; the step
  already disarmed the PR. Leave any PR open and the code unchanged by the stop.

Never offer **Merge as-is** with blockers at any round. Nitpicks / warnings alone on
a green verdict do not require escalation.

### Escalation dossier (on `stop`, or when the bound is already spent)

Publish as a PR comment when a PR exists; otherwise display locally:

1. Review/commit references and residual blockers (quote the latest review refs).
2. Recurring mechanisms across rounds (round-local RC IDs).
3. Fix-induced defects observed after a fix round.
4. Higher-level hypothesis — labelled **hypothesis, not certainty** — plus the
   falsifying observations that would discriminate it.
5. Exactly 2–3 human options (revised diagnostic plan via a NEW superseding PR,
   revised design/scope via a NEW superseding PR, or the operator finishing this
   PR by hand). Generic "retry" is not an option.
6. Explicit ask: automation on this PR is finished. A superseding PR (a revised
   ticket via issue-triage linking this PR, a new branch, a fresh `/feature`)
   starts its own bound; the stopped PR stays open as evidence until the operator
   closes it. The bound counts the automation account's records only.

> Review findings are fixed by `skill://fix`; CI-only failures use `/feature` §6.5.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| \|Δ\| = 0 | Halt |
| Binary ∈ Δ | Skip, note |
| \|Δ\| > 50 | Warn, suggest split |
| F = ∅ | Clean approve, post, Phase 8 |
| Critical security | Escalate in findings, flag in verdict |
| Agents disagree | Present both with respective C |
| ¬∃ PR | Render Phase 4 body; Phase 8 local only, no bound |
| Missing root cause/solutions | C(f) := 0; keep finding; `skill://fix` files its cause instead of applying it |
| ∄ `size:` label | τ := F-lite, disclosed out loud (never silently) |
| R-architect skipped | no axial or structural evidence |
| R-tester skipped | ¬delta_test_hit and ¬untested-change |
| R-security-auditor skipped | path_hit=false — R-adversarial owns OWASP on every review |
| FE/BE concern in Δ | R-adversarial floor owns it — the domain roles are cut, ¬spawn a substitute |
| Low-confidence finding | keep; it joins its cause; confidence orders, it does not split the fix queue |
| Recall worker skipped | single chunk ∨ class appears in <2 chunks ∨ <3 unique callsites |
| roster capped (max_agents, per chunk) | disclosed when ≠ ∅ (Phase 4) |
| oracle warnings ≠ ∅ | echoed into output; review_halt → HALT |
| bound already spent on entry (`nextReviewStep(cwd, pr, { reviewing: true })` → `stop`, gate disarmed) | dossier; ¬review; ¬Fix; ¬Merge |

## Safety Rules

1. Fresh agents only — ¬implementation context
2. ¬approve PRs on GitHub; ¬enable auto-merge outside a green `land` step through `landPr`
3. Merge = merge commit only, ¬squash; merge executes via the gate (label + auto-merge), never manually mid-CI
4. ¬fix code — findings only. Fixing = `skill://fix` after a `fix` step
5. ∃ PR → must post the Phase 4 body
6. Human decides at Phase 8 — ¬proceed without Q
7. ¬merge with residual blockers at any round; warnings-only may use normal gated landing

## Chain Position

- **Phase:** Verify
- **Predecessor:** implement
- **Successor:** conditional — green `land` → gated landing | red `fix` → `skill://fix` | `stop` → escalation dossier + human guidance
- **Class:** verdict (branching based on findings)
- **Loop cap:** at most 2 automatic fixes, derived by `nextReviewStep` from the review records. A record past the second that does not approve → stop + dossier; never Merge-as-is with blockers.

$ARGUMENTS
