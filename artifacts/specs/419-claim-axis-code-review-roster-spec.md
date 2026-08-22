---
title: "Control quality: claim-axis /code-review roster (V2 of #417)"
description: "Structured SC claim tags drive /code-review control spawn; path globs retained until classifier proven."
type: spec
status: approved
issue: 419
tier: F-lite
date: 2026-08-22
---

## Context

**Promoted from:** [frame](../frames/419-claim-axis-code-review-roster-frame.md)
**GitHub issue:** #419
**Predecessor:** #417 V1 / PR #418 (`run-falsify` oracle + sole `oracle_ok`). This slice is claim **(3)** / breadboard **U5** from the #417 spec — deferred intentionally.

## Intent

`/code-review` still spawns security-class and infra agents from **filename globs** (`**/auth/**`, `scripts/`, …). A priced fail-closed / authz / SSoT SC can miss control density when sources sit outside those globs; authors can also steer spawn if we ever regex free-text claim words.

We need roster density to key off a **structured** `claim:` field on priced SC YAML fences, with **fail-closed** behavior when claims are missing or invalid — without deleting path globs until a classifier is proven.

## Goal

`/code-review` spawns security-auditor when path globs hit **or** the issue’s resolved approved spec carries valid `claim:` tags (interim: any such tag on σ when Δ ≠ ∅ — **not** yet per-SC source∩Δ). Priced fences without valid `claim` fail `priced_ok` at `/pr` **and** force security-auditor spawn (or review halt) at `/code-review`. Structural path triggers remain until a later classifier-green PR removes them.

## Users

- **Primary:** maintainers running `/spec` → `/code-review` who need control spawn tied to priced claims.
- **Secondary:** authors of fail-closed/authz/SSoT specs who must set `claim:` so omission cannot skip security-class coverage.

**Story:** As a maintainer, I want security-auditor spawn from structured `claim:` on the resolved approved spec (and refuse/halt on invalid claims) so path-only roster cannot skip control coverage.

## Out of Scope

- Re-opening `run-falsify` / `oracle_ok` design (done in #417) — extending priced parse for `claim:` is authoring completeness only, ¬a new refuse boolean.
- Kit bar / `classifyOrigin` / CP-FALSIFY (`roxabi-boilerplate-cf`).
- Deleting path globs in this PR (unconditional retention — no escape marker).
- Full natural-language claim inference from SC prose.
- True per-SC **source∩Δ** claim intersection (follow-on when falsify matrix maps SC→sources).

## Constraints

- **Honest interim semantics:** Goal/user story must **not** say “Claims ∩ Δ” until source maps land. This cycle: `Claims` = ∪ tags from all valid priced fences on resolved σ; spawn when `Δ ≠ ∅ ∧ Claims ∩ tags ≠ ∅`.
- **Review before `/pr`:** `/code-review` may run on WIP branches; invalid priced/claim YAML must still fail closed at dispatch (forced spawn or halt — see S1).
- **Migration:** existing approved specs with priced fences but no `claim:` must be updated before merge of this PR (at minimum this issue’s σ; repo-wide grep + add tags in same PR or blocking follow-up noted in plan).

## Expected Behavior

### Authoring (`/spec` + `/pr`)

1. Priced YAML fence (`priced` / `not` / `oracles`) **must** include `claim: [fail-closed|authz|ssot]` (YAML list; block or flow `[a, b]`; scalar `claim: fail-closed` normalized to one-element list).
2. **Structural mandate:** scan **every** fenced YAML block that contains a `priced:` key — not only SC checkboxes matching prose stems (`PF_PRICED_SIG`). Unknown tag, empty list, or missing `claim:` → `priced_ok=false`.
3. Multiple priced fences per spec: validate independently; one failure → `priced_ok=false`.

### Resolve approved σ (deterministic — replaces ad-hoc branch grep alone)

At `/code-review` Phase 2 (extend) and S1, resolve `(issue_num, spec_path)` in order:

| Priority | Source |
|----------|--------|
| 1 | `/code-review #PR` → `gh pr view PR --json number,headRefName` → issue from PR body “Fixes #N” / “Closes #N” / linked issue; else first digit run in head branch `feat/{N}-*` |
| 2 | Current branch `feat/{N}-*` → N |
| 3 | Fallback: first `\d+` in branch name (legacy — warn once) |

Then `spec_path` = lexicographically first `artifacts/specs/{N}-*.md(x)` in the worktree. Reject `status: draft` in frontmatter → treat as **no approved σ** (Claims empty; path-only spawn; warn in Phase 2).

### Review dispatch (S1 + Phase 3)

4. **S1** (`skills/code-review/claim-roster.ts` + thin `claim-roster.sh` wrapper) — sole spawn oracle:

```text
claim-roster.sh --spec PATH --diff-list FILE [--json]
  # FILE: newline-separated repo-relative paths (= Δ)

Exit 0 + JSON:
  path_hit: bool
  claims: string[]          # normalized tags from valid priced fences
  spawn_security_auditor: bool
  priced_claim_ok: bool     # all priced fences on σ have valid claim
  review_halt: bool         # true only when --spec missing/unreadable (optional halt)

Rules:
  path_hit := Δ matches existing security-auditor path/token rule (same as today)
  spawn_security_auditor := path_hit
                         ∨ (|Δ|>0 ∧ claims ∩ {fail-closed,authz,ssot} ≠ ∅)
                         ∨ (|Δ|>0 ∧ ¬priced_claim_ok ∧ spec has ≥1 priced: key)
  # last disjunct = review-time fail-closed when σ has priced fences but invalid claim

Exit 2 when priced fences exist and priced_claim_ok=false (stderr explains); orchestrator still reads JSON if present else forces spawn_security_auditor=true.
```

5. **Multi-chunk:** `spawn_security_auditor` is computed **once per review** from full Δ + σ. Per-chunk Lane A uses the same boolean (do not re-parse σ per chunk). Existing security-auditor **scoping** (imports + auth paths) still applies to chunk file sets when spawned.

6. **When / Skip / parity surfaces** must all reference the same predicate `spawn_security_auditor` (via S1 output or identical prose formula). Mechanical test greps these locations and fails on path-only skip drift:

   - `skills/code-review/SKILL.md` — security-auditor **When** row, **Skip** line, Security-auditor scoping intro, agent-name map parenthetical
   - `skills/code-review/README.md` — spawn table row for security-auditor

7. **Path glob retention (unconditional this PR):** listed triggers stay in architect/devops/security-auditor **When** cells. CI test fails if any listed token/glob is removed from those cells. **No** `classifier_proven` marker in this cycle — removal is always a test failure until a follow-on PR updates the retention test itself.

8. Adversarial remains **always** — claim rails do not add adversarial skip.

9. **No approved σ / no issue / draft σ:** Claims empty; `priced_claim_ok` ignored; behavior = path globs only (documented; not sold as claim-axis complete).

## Data Model & Consumers

### Data Structure

| Field | Notes |
|-------|--------|
| `priced` / `not` / `oracles` | existing |
| `claim` | **new** — non-empty list ⊂ `{fail-closed, authz, ssot}`; required whenever `priced:` exists in the same YAML fence |

Parse rules: strip quotes; lowercase tags; reject unknown; dedupe; `claim: ssot` → `["ssot"]`.

### Consumers

| Consumer | Fields consumed | When | Status |
|----------|-----------------|------|--------|
| `/spec` template + SKILL | `claim` docs + structural rule | authoring | This issue |
| `parse-falsify.sh` `pf_parse_priced` (extend) | all `priced:` fences + `claim` | `/pr` `priced_ok` | This issue |
| S1 `claim-roster` | σ, Δ, path rule | `/code-review` Phase 3 pre-dispatch | This issue |
| `/code-review` Phase 2 | σ resolver + `status≠draft` | before spawn | This issue |
| SKILL When/Skip/README + retention test | spawn predicate + glob tokens | dispatch + CI | This issue |
| Tests | fixtures below | CI | This issue |

## Breadboard

| ID | Element | Handler | Data |
|----|---------|---------|------|
| U1 | Template + SKILL `claim:` | `spec/references/templates.md`, `spec/SKILL.md` | authoring |
| U2 | Priced-fence scan + `claim` validate | extend `parse-falsify.sh` | `priced_ok` |
| U5 | Deterministic σ resolver | extend `code-review` Phase 2 | issue, spec_path |
| S1 | Spawn oracle | `code-review/claim-roster.ts` + `.sh` | JSON + exit codes |
| U3 | When + Skip + README parity | `code-review/SKILL.md`, README | `spawn_security_auditor` |
| U4 | Unconditional glob retention test | test greps When cells | listed tokens |

Wiring: U1 → U2. U5 → S1 → U3. U4 ∥ U3. U2 before U3 in same PR.

## Slices

| # | Name | Scope | Demo |
|---|------|-------|------|
| V2 | Claim-axis roster | U1, U2, U5, S1, U3, U4 | spawn from claims; invalid claim fail-closed; When/Skip parity; globs retained |

## Success Criteria

- [ ] `/spec` template and SKILL document required `claim:` on every priced YAML fence (closed tag set).

- [ ] Extended priced parse: any YAML fence with `priced:` but invalid/missing `claim` → `priced_ok=false` (all fences, not prose-stem-selected).

```yaml
claim: [fail-closed]
priced:  "every priced YAML fence carries a valid non-empty claim list from the closed set"
not:     "grep SC prose for fail-closed/authz or only PF_PRICED_SIG-selected checkboxes"
oracles:
  - "priced/not/oracles without claim: → priced_ok=false"
  - "claim: [unknown-tag] → priced_ok=false"
  - "claim: [] → priced_ok=false"
  - "claim: [ssot] only (no prose stems) → priced_ok=true"
```

- [ ] S1 returns `spawn_security_auditor=true` when σ has `claim: [fail-closed]` and Δ is only `skills/foo/bar.ts` with `path_hit=false`.

```yaml
claim: [fail-closed]
priced:  "valid claim tags on σ force security-class spawn even when Δ misses **/auth/**"
not:     "widening path globs or editing SKILL When prose without calling S1"
oracles:
  - "fixture: claim-roster.sh --spec fixtures/spec-fail-closed.md --diff-list fixtures/delta-plugin.txt → spawn_security_auditor=true"
```

- [ ] Review-time fail-closed: σ with `priced:` but invalid `claim` and Δ ≠ ∅ → `spawn_security_auditor=true` (or `review_halt=true` with blocking finding) even when `path_hit=false`.

```yaml
claim: [authz]
priced:  "invalid/missing claim on priced fence cannot skip security-auditor at review time"
not:     "relying only on priced_ok at /pr while /code-review runs earlier on WIP"
oracles:
  - "fixture: spec priced fence missing claim → spawn true OR review_halt true with priced_claim_ok=false"
```

- [ ] When, Skip, README security-auditor rows match `¬spawn_security_auditor` skip semantics; mechanical test fails if Skip reverts to path-only.

```yaml
claim: [ssot]
priced:  "Claims-driven spawn cannot be dropped by stale path-only Skip text"
not:     "When row updated without Skip/README/agent-map parity"
oracles:
  - "test: grep Skip line and README row — must not say only 'Δ misses auth/secrets/crypto' as sole skip condition"
```

- [ ] Path globs/tokens remain in architect/devops/security-auditor When cells; removal fails CI with no in-repo escape marker.

```yaml
claim: [fail-closed]
priced:  "listed path triggers remain in When cells until a follow-on PR updates the retention test"
not:     "comment-only retention or classifier_proven marker without changing the test"
oracles:
  - "test greps When cells for scripts/, **/auth/** (and documented siblings); delete trigger → test fails"
```

- [ ] Deterministic σ resolver: `/code-review #PR` uses PR-linked issue before branch digit fallback; draft frontmatter → no Claims (warn).

```yaml
claim: [authz]
priced:  "code-review resolves issue/spec from PR linkage before ad-hoc branch grep"
not:     "only git branch --show-current | grep digits"
oracles:
  - "fixture or doc test: PR with Fixes #N loads artifacts/specs/N-*.md; draft status excluded"
```

- [ ] Adversarial remains always-on; no new When/Skip skip keyed on `claim`.

## Open Questions

None blocking. Documented defaults:
- Interim Claims = all valid tags on resolved approved σ when Δ ≠ ∅ (over-spawn accepted).
- True source∩Δ deferred to falsify-matrix follow-on.
- Legacy specs: add `claim:` to any priced fence in files touched by this PR; plan lists any remaining repo specs for same treatment.
