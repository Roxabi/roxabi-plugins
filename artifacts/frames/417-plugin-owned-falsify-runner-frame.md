---
title: "Control quality: plugin-owned falsify runner (markdown is a report)"
issue: 417
status: approved
tier: F-full
date: 2026-08-21
---

## Problem

#415/#416 shipped priced SCs, a mechanical `parse-falsify.sh`, and a thinner `/code-review` roster. Two `/fix` rounds then stacked more proxies on that surface (heading → parse markdown → git-diff+tokens; fingerprint → package.json tokens → THRESHOLD if `validate:full`). The control still measures **document shape and token presence**, not whether the mapped tests actually break when the priced source is removed.

Downstream, kit work in `roxabi-boilerplate-cf` (#101→#102) hit the same wall: origin policy and CP-FALSIFY cannot share a generic runner that does not exist yet, so they invent path denylists and in-tree mutates sold as gates.

**Why now:** the matcher path is exhausted. Architectural follow-up — not another patch on #416.

## Who

- **Primary:** dev-core maintainers running `/implement` 6b → `/pr` → `/code-review` — need one executable falsify oracle and one “proven” signal so parser-ok cannot skip the tester.
- **Secondary:** kit / boilerplate authors blocked on a plugin-owned runner for bar + origin-policy falsify (claims 4–6 live in another repo).

## Constraints

- This repo ships **claims (1)(2)(3)** only. Claims (4)(5)(6) stay in `roxabi-boilerplate-cf`, blocked on (1) for a generic runner.
- Build on #416 surfaces (`parse-falsify.sh`, Step 6b, roster skip rules) — replace oracle ownership, ¬throw away priced SC contract.
- Markdown / PR body remains a **report** of evidence, never the pass oracle.
- Out of band for this effort: more path denylists, error-token greps, priced keyword stems, IPv6 literals, THRESHOLD exceptions.

## Out of Scope

- Kit bar SSoT / `check-bar-ssot.sh` / `validate:full` step-list surgery (claim 4).
- `classifyOrigin` kind taxonomy + test pinning (claim 5).
- Kit-specific CP-FALSIFY canary (claim 6) — consumes (1) later.
- Another matcher / token / THRESHOLD patch on `parse-falsify.sh` as the primary fix.

## Premise Validity

**Success in 6 months:** for a τ≠S change with mapped unit/fast-integration tests, “proven” is recorded only after an executable run fails under source-stash (or equivalent) and passes when restored — and `/implement` 6b, `/pr`, and `/code-review` tester-skip all read that same helper. Roster spawn keys off priced claim of the diff (fail-closed / authz / SSoT) or adversarial-only. Boilerplate can invoke the plugin runner for its bar without inventing a second oracle.

**Failure in 6 months:** after ship, a PR can still clear `/pr` or skip tester because markdown/parser tokens look right while stash-restore never ran — or roster still keys off filename globs (`scripts/`, `**/auth/**`) so priced fail-closed diffs miss adversarial coverage. Observable: green PR + skip with no executable evidence log.

**Simplest alternative:** keep stacking matcher rules on `parse-falsify.sh` and roster path globs (the #416 trajectory).

**Why not simplest:** priced quantity is still not what the control measures. Proxies compound (`/fix` twice already); kit stays blocked without a real runner; another denylist does not close the oracle gap.

## Complexity

**Tier: F-full** — from `size:F-full`. Cross-skill contract (implement / pr / code-review / tester), new executable helper as shared oracle, and a roster axis change away from path globs. Multi-domain with design unknowns → F-full.

Signals observed:
- Issue label `size:F-full`.
- Touches ≥3 skill surfaces + agent skip logic + likely a new script/helper under `plugins/dev-core/`.
- Architectural: oracle ownership + single “proven” API + claim-driven roster (not filename axis).
- Unknowns: stash-vs-equivalent runner shape; how parser-ok relates to the new helper without dual skip paths; exact priced-claim → spawn map.
