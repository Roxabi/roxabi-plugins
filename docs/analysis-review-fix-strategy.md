# Analysis: `/code-review` + `/fix` strategy redesign

> Strategic locked decision after grilling session 2026-05-05. Replaces the
> implicit lens-only model in `plugins/dev-core/skills/code-review/` and the
> TODO dispatch rules in `plugins/dev-core/skills/fix/SKILL.md:140-142`.

**Date:** 2026-05-05
**Status:** Strategy locked, implementation sliced (5 slices, each shippable)
**Scope:** `dev-core:code-review` + `dev-core:fix`
**Origin:** [lyra recurring-bug audit 2026-05-01 / 2026-05-03](../../lyra/artifacts/) — RC-3, RC-6, RC-7 unaddressable by current pipeline

---

## 1. Problem

Today's `/code-review` (cf. `plugins/dev-core/skills/code-review/SKILL.md:80-124`):

| Behavior | Consequence |
|---|---|
| Every domain agent receives **full diff + all changed file contents** | Context explodes on PRs ≥50 files; cost = O(diff × N agents) |
| Sharding = parallel-lensing only, not workload partition | More agents ≠ less work per agent |
| Dedup = `(file:line, label)` exact match | Same anti-pattern at different lines = "duplicate" → pattern signal lost |
| `patterns_observed` does not exist as an output | RC-6 (point ≠ pattern) recurs by design |
| `|Δ| > 50` → soft warn user, no auto-shard | Reviewer drowns or human pre-splits |

`/fix` Phase 6 (cf. `plugins/dev-core/skills/fix/SKILL.md:140-142`):

| Behavior | Consequence |
|---|---|
| `\|acc\| ≥ 3 → spawn agent(s) per dispatch + batching rules` | Rules are **referenced but never defined** — orchestrator improvises |
| No falsification gate after apply | RC-7 (fix-pass introduces net-new defects) recurs by design |
| Single-finding cited line treated as exhaustive | RC-6 recurs at fix time too (PR #1036 — 3 `shell=True` cited + fixed, 3 more in same file untouched) |

---

## 2. Strategic stack (locked)

```
┌────────────────────────────────────────────────────────────────┐
│ FRAME       Hybrid: architecture-down (memory:                 │
│             "task-level tooling is the wrong abstraction")     │
├────────────────────────────────────────────────────────────────┤
│ PIPELINE    Option 4: gated 2-step + post-fix falsification    │
│             + class-graduation cron                            │
├────────────────────────────────────────────────────────────────┤
│ SHARDING    S4: Targeted Recall                                │
│             closed-class tags + raw_callsites per finding      │
│             + recall agent on cross-chunk class hits           │
├────────────────────────────────────────────────────────────────┤
│ TAXONOMY    T2: canonical core + candidate namespace           │
│             + cron-graduation                                  │
└────────────────────────────────────────────────────────────────┘
```

### 2.1 Pipeline shape (Option 4 + S4 merged)

```
                          ┌─────────────────┐
                          │   PR / branch   │
                          └────────┬────────┘
                                   ▼
                         ┌─────────────────────┐
                         │  Chunker (O2)       │   stable directory tree;
                         │  budget = 0.4×ctx   │   LOC-bounded fallback only
                         └─────────┬───────────┘
                                   ▼
   ┌──────────────────────────────────────────────────────────────┐
   │ LANE A — per-chunk primary (parallel)                        │
   │   ∀ c_i: spawn { backend, frontend, tester, devops }         │
   │   each receives: c_i full + boundary digest of others        │
   │   output: findings + raw_callsites per class                 │
   │           patterns_observed (closed taxonomy tags)           │
   └─────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
                  ┌─────────────────────────┐
                  │  Cross-chunk join       │   group raw_callsites by
                  │  (orchestrator)         │   class. Trigger condition:
                  └────────┬────────────────┘   class in ≥2 chunks OR
                           │                    ≥3 callsites in 1 chunk
                  ┌────────┴────────┐
        no class triggered │  class triggered
                           │           │
                           │           ▼
                           │  ┌──────────────────────────────┐
                           │  │ TARGETED RECALL              │
                           │  │ focused agent / class        │
                           │  │ input: callsites + ±N ctx    │
                           │  │        + cross-chunk index   │
                           │  │ job: confirm scope (RC-3)    │
                           │  │      find un-cited (RC-6)    │
                           │  │ findings = BLOCKING          │
                           │  └──────────┬───────────────────┘
                           │             │
                           ▼             ▼
                  ┌─────────────────────────────────┐
                  │ Lane B reduce (advisory)        │   security-cons +
                  │ summaries only, no raw content  │   arch-cons; receive
                  │                                 │   patterns_observed
                  │                                 │   + boundary digests
                  └────────┬────────────────────────┘
                           ▼
                  ┌─────────────────────────────────┐
                  │ MERGE + verdict                 │   recall = blocking
                  │   dedup on (class, file)        │   advisory = warn
                  └────────┬────────────────────────┘
                           ▼
                  ┌─────────────────────────────────┐
                  │ /fix dispatch (O3)              │   group acc by class
                  │   shard within class ≤3 files   │   per fixer
                  └────────┬────────────────────────┘
                           ▼
                  ┌─────────────────────────────────┐
                  │ FALSIFICATION GATE (per class)  │   delete the new
                  │   boolean only; new findings    │   guard, expect test
                  │   → parking lot, never reopen   │   to fail
                  └────────┬────────────────────────┘
                           ▼
                       merge / push

   ┌──────────────────────────────────────────────────────────────┐
   │ BACKGROUND (weekly cron)                                     │
   │   class-catalog graduation: candidate hit ≥3×/30d → PR       │
   │   lint graduation: canonical class hit ≥5×/90d → blocking    │
   │     issue auto-filed; merges in class blocked until lint     │
   │     exists OR class formally accepted as "LLM-only forever"  │
   └──────────────────────────────────────────────────────────────┘
```

### 2.2 Why S4 over alternatives

| Considered | Rejected because |
|---|---|
| S1 — lens-only (status quo) | O(diff × N) cost; doesn't scale past ~50-file PR |
| S2 — disjoint partition, no cross-cutting | Loses RC-3/RC-6 detection at chunk boundaries |
| S3 — partition + boundary digest, cross-cutting opts out | Cross-cutting opt-out reproduces context explosion on those agents |
| S3' — hierarchical reduce on summaries | **Architect verdict**: summaries compress away the locations needed for relational findings (RC-3/RC-6). Right load-reduction, wrong detection mechanism |

---

## 3. Sub-decisions (O1–O4)

### O1 — Confidence gating (3-tier)

```
C(f) ≥ 90%  AND  |A(f)| ≥ 1  →  straight to /fix (no extra check)
70% ≤ C(f) < 90%             →  1 verifier (different domain from src(f))
C(f) < 70%                   →  2 PoV from distinct domains;
                                 require agreement to enter /fix queue
```

Rationale: today's flat T=80 (`fix/SKILL.md:49`) over-checks high-confidence findings and under-checks low-confidence ones. 3-tier matches verification cost to uncertainty.

### O2 — Chunker design

| Rule | Detail |
|---|---|
| Primary unit | Stable directory tree (`src/lyra/core/*` is one chunk) — preserves cohesion across PRs |
| Fallback | LOC-bounded split only when a single directory exceeds the budget |
| Budget | `0.4 × active_model_context_window` — dynamic, not hard-coded constant |
| Implementation | Python module with tests; **never** a bash script (RC-4 mitigation) |
| Required tests | Empty diff · all-in-one-domain · balanced split · single oversized file · cross-directory rename |

### O3 — `/fix` dispatch rules

```
Phase 6 — Apply 1b1 Decisions  (replaces fix/SKILL.md:140-142)

  group acc by class:                 // closed taxonomy from S4
    classes = { c | ∃ f ∈ acc: cls(f) = c }

  ∀ class ∈ classes:
    files_in_class = unique({ file(f) | f ∈ acc, cls(f) = class })

    |files_in_class| ≤ 3   →  single fixer agent for the class
    |files_in_class| > 3   →  shard by file: ⌈|files| / 3⌉ fixers
                              each fixer owns ≤3 files of same class

  Fixer payload:
    - findings (with class + raw_callsites)
    - chosen solution per finding
    - diff context for owned files
    - "re-read targets before editing; lint+test after each fix;
       sweep file for same class anti-pattern, justify or fix
       any uncited hit"  ← RC-6 mitigation built into payload
```

### O4 — Falsification gate semantics

| Property | Value |
|---|---|
| Output | Boolean per class only (`pass` / `fail`) |
| Method | Delete the new guard / new test setup; expect test to fail. If passes → tautological (RC-1). |
| New findings during falsification | **Parking lot** — file as candidate finding for next PR cycle. Never reopen current `/fix` loop (closes pre-mortem F4: prevents 3-iter cap from regressing) |
| Scope | Only the class being fixed. New cross-class anti-patterns surfaced → parking lot too |

---

## 4. Taxonomy (T2)

### 4.1 Canonical core (versioned, in plugin)

Path: `plugins/dev-core/skills/code-review/review-classes.yml` (new)

| Class | Origin | Description |
|---|---|---|
| `test-tautology` | RC-1 | Test passes when guard is removed |
| `generator-drift` | RC-2 | Hand-edit to file with a generator script (acl-matrix, importlinter contracts, CONFIGURATION.md) |
| `parallel-path-drift` | RC-3 | Safety hardening applied to one entry point but not its sibling |
| `bash-safety` | RC-4 | Specific bash anti-patterns: `((c++))+set -e` · `return >255` · `jq -r` returns `"null"` · `2>/dev/null` swallow · jq `//` coerces `false` |
| `shell-injection` | OWASP | `subprocess.run(..., shell=True)` with user-derived input |
| `sql-injection` | OWASP | String-concatenated SQL with user-derived input |
| `missing-error-handling` | OWASP | `except: pass` · bare except · uncaught coro · ignored Result |
| `missing-input-validation` | OWASP | External input reaches sensitive sink without validation |
| `secret-leak` | OWASP | Credentials / API keys in code, logs, or commit history |
| `bare-except` | OWASP | `except Exception: pass` swallowing |
| `path-traversal` | OWASP | User-derived path passed to filesystem ops without normalization check |
| `unbounded-loop` | OWASP | Loop / recursion without bound or timeout |

### 4.2 Candidate namespace (runtime, ephemeral)

- Storage: `~/.dev-core/candidate-classes.jsonl` (per-machine, append-only)
- Schema per entry: `{ class: "candidate/<slug>", finding_id, pr, hit_at, agent_src }`
- Findings tagged `candidate/*` are **advisory only** — never trigger recall
- Multi-tag allowed: a finding can carry one canonical + one candidate tag

### 4.3 Graduation cron

```
weekly:
  ∀ candidate/<slug> in jsonl:
    occurrences = count(slug, last 30d)
    distinct_prs = count(distinct pr, last 30d)

    occurrences ≥ 3 AND distinct_prs ≥ 2
      → file PR to roxabi-plugins:
          - add canonical entry to review-classes.yml
          - body: list of (pr, finding_id, agent_src) evidence
          - label: graduate-class
          - assignee: @human (manual review required)

  ∀ canonical class in review-classes.yml:
    occurrences = count(class, last 90d, across all repos)

    occurrences ≥ 5
      → file issue:
          - title: "graduate: deterministic check for {class}"
          - label: priority/high, blocks-merges
          - body: hit list, suggested check (ruff plugin / pre-commit /
                  importlinter contract / language-specific lint)
          - merges in this class blocked until issue closes OR
            class formally accepted as "LLM-only forever" (rationale required)
```

---

## 5. Pre-mortem (mitigations baked into design)

| # | Failure mode | Mitigation in design |
|---|---|---|
| F1 | `patterns_observed` free-text drift | Closed taxonomy (T2 §4.1); free text rejected at output validation |
| F2 | Boundary digest can't carry RC-3 signal | Digest must include call-graph edges to named entry points + modified ACL/contract hunks (not just signatures) |
| F3 | Chunking boundary fragments anti-pattern across chunks | Each finding emits `raw_callsites` (file:line) — Lane B joins on `(class, file)`, not on prose |
| F4 | Lane B hallucinates from summaries | Lane B = advisory only; recall agent (real code) is the verdict-grade path |
| F5 | Lane B sequential bottleneck | Streaming reduce — consolidator processes summaries as Lane A chunks finish |
| F6 | Falsification surfaces new findings → 3-iter cap regresses | Parking lot for cross-class finds (O4); falsification gate emits boolean only |
| F7 | `/fix` treats Lane B findings same as Lane A | Lane B output carries `pattern-class` tag; `/fix` routes pattern-class via Phase 6 class-shard (O3) |
| F8 | Class catalog never grows = scalability promise unfulfilled | Cron auto-files PRs (T2 §4.3) — graduation is structural, not aspirational |
| F9 | Chunker becomes ad-hoc bash blob (RC-4 echo) | Python module + tests mandated (O2) |
| F10 | Token-budget tuning becomes operational toil | Budget = `0.4 × active_model_context_window`, computed dynamically per run |

**Highest-residual risk**: F8. If the cron runs but no human acts on filed graduation PRs, the catalog stagnates. Mitigation outside this design: graduation PRs carry `priority/high` and block class-related merges after a threshold.

---

## 6. Implementation slices

Each slice is independently shippable and delivers user-visible value alone.

### Slice 1 — Foundations (taxonomy + tagging)

**Scope:** T2 canonical YAML + extend `/code-review` Phase 3 spawn template to require `class` tag + `raw_callsites` field on every finding. Multi-tag allowed.

**Files:**
- new `plugins/dev-core/skills/code-review/review-classes.yml`
- edit `plugins/dev-core/skills/code-review/SKILL.md` Phase 3, finding format
- edit `plugins/dev-core/skills/fix/SKILL.md` Phase 1 parser to read `class` + `raw_callsites`

**Standalone value:** Every finding gets classified, even before sharding. Today's pipeline benefits immediately. Telemetry-grade data for tuning future slices.

**Acceptance:**
- All findings carry exactly 0–N canonical tags + 0–1 candidate tag
- Validation rejects free-text labels not in YAML or candidate namespace
- `raw_callsites` is `(file, line)` list, never empty when class is set

### Slice 2 — Chunker + boundary digest

**Scope:** Implement chunker (directory-cohesion + LOC-bounded fallback) + boundary digest emission. Recall not yet wired.

**Files:**
- new `plugins/dev-core/skills/code-review/chunker.py` + tests
- new `plugins/dev-core/skills/code-review/digest.py` + tests
- edit Phase 3 to dispatch per-chunk Lane A agents

**Standalone value:** PRs `|Δ| > 50` become reviewable without context overflow; sharding is now load-balanced by file/LOC, not lens-multiplied.

**Acceptance:**
- Budget computed dynamically from active model context window
- Chunker is Python (not bash)
- Tests cover: empty diff · single oversized file · balanced split · cross-directory rename

### Slice 3 — Targeted recall

**Scope:** Cross-chunk class join + recall trigger + recall agent definition + verdict gate.

**Files:**
- edit `plugins/dev-core/skills/code-review/SKILL.md` post-Lane-A merge logic
- new `plugins/dev-core/agents/recall.md` (focused agent definition)
- update verdict rule: recall findings = blocking; Lane B summaries = advisory

**Standalone value:** RC-3 and RC-6 become detectable for the first time. Pattern-aware merging closes the dedup-collapse hole.

**Acceptance:**
- Recall triggered on `class hits ≥2 chunks OR ≥3 callsites in 1 chunk`
- Recall agent receives only callsites + ±N context, never full diff
- Verdict separates blocking (recall) from advisory (Lane B)

### Slice 4 — `/fix` dispatch + falsification

**Scope:** Replace `fix/SKILL.md:140-142` TODO with O3 rules. Add post-apply falsification gate per class.

**Files:**
- edit `plugins/dev-core/skills/fix/SKILL.md` Phase 6 + new Phase 6.5 (falsification)
- new `plugins/dev-core/skills/fix/falsification.md` (gate definition)

**Standalone value:** Closes RC-7 (fix-pass introduces defects). Multi-file fixes shard by class, not by accidental orchestrator improvisation. Parking lot prevents 3-iter cap regression.

**Acceptance:**
- Phase 6 dispatch is fully specified — no "per dispatch + batching rules" forward-reference
- Falsification gate emits boolean per class
- New findings during falsification → parking lot, never reopen current loop

### Slice 5 — Graduation cron

**Scope:** Class-catalog graduation cron + lint-graduation cron.

**Files:**
- new `plugins/dev-core/skills/class-graduation/SKILL.md`
- new cron / GitHub Action wrapper invoking the skill weekly

**Standalone value:** System self-curates over time. Long-term scalability promise becomes structural, not aspirational.

**Acceptance:**
- Candidate → canonical: PR auto-filed when `≥3 hits / 30d / ≥2 PRs`
- Canonical → lint: issue auto-filed with `priority/high + blocks-merges` when `≥5 hits / 90d`
- Both runs idempotent (re-running same week doesn't duplicate PRs/issues)

---

## 7. Open governance questions (deferred)

| Q | Why deferred |
|---|---|
| Who owns the canonical taxonomy YAML? Single human approver vs review by N? | Not blocking Slice 1; revisit after first 2 graduation PRs land |
| How to handle multi-repo class catalog (lyra, voiceCLI, llmCLI)? | Plugin lives in roxabi-plugins, classes are universal — defer multi-repo telemetry to Slice 5 |
| `0.4 × context_window` — is 40% the right budget split? | Tunable constant; pick once measured under real load |
| Do we keep the `architect` cross-cutting Lane B agent or drop it? | Lane B is advisory-only post-S4; cost-benefit unclear until we have telemetry |

---

## 8. Out of scope (separate sessions)

- Lyra 4-layer roadmap (orchestration / worker / harness / memory) — strategically larger than this one; deserves its own grilling
- voiceCLI / llmCLI improvements — same
- Floor-clearer (DP-collapse on `merge as-is`) — explicitly skipped this session

---

## References

- `plugins/dev-core/skills/code-review/SKILL.md` — current spec (will edit)
- `plugins/dev-core/skills/fix/SKILL.md` — current spec (will edit)
- lyra recurring-bug audit (memory: `project_recurring_bug_classes.md`) — RC-1 through RC-7
- lyra orchestration memory (`project_orchestration_layer.md`) — "task-level tooling is the wrong abstraction"
- Conventional Comments — finding label format
