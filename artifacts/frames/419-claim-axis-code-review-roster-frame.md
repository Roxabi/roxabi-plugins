---
title: "Control quality: claim-axis /code-review roster (V2 of #417)"
issue: 419
status: approved
tier: F-lite
date: 2026-08-21
---

## Problem

#417 V1 (#418) made `run-falsify.sh` the sole executable oracle and demoted markdown/`parse-falsify` out of the gate graph. Claim **(3)** — roster spawn by **priced claim of the diff**, not filename globs alone — was explicitly deferred.

Today `/code-review` still keys architect/devops/security-auditor (and related skips) off structural path triggers (`scripts/`, `**/auth/**`, …). A fail-closed / authz / SSoT priced SC can land outside those globs and miss control-agent density; conversely, path hits can spawn without a priced claim. Authors can also omit claim words in prose to steer spawn if we ever regex free text.

**Why now:** oracle ownership is shipped; the remaining #417 slice is the claim axis. Path globs stay until a classifier is proven — this cycle adds structured `claim:` tags + spawn from tags ∩ Δ, fail-closed when tags are missing on control-shaped Δ.

## Who

- **Primary:** dev-core maintainers running `/spec` → `/implement` → `/code-review` — need spawn density tied to priced claims, not filenames.
- **Secondary:** authors of fail-closed/authz/SSoT specs who must tag SCs so reviews cannot skip control agents by path or prose omission.

## Constraints

- Build on #417/#418 surfaces only — ¬reopen `run-falsify` / `oracle_ok` design.
- Structured SC field `claim: [fail-closed|authz|ssot]` (template + parser) — ¬free-text keyword stems as the classifier.
- Missing tags on control-shaped Δ → **fail-closed spawn** (adversarial + security-class), not skip.
- **Retain** structural path triggers until the claim classifier is proven — ¬delete `scripts/` / `**/auth/**` globs in this PR.
- Priced SCs with oracles that fail-closed on “omit claim words to skip spawn” and “delete auth glob without classifier”.

## Out of Scope

- Re-opening oracle / `run-falsify` / `oracle_ok` (done in #417).
- Kit bar / `classifyOrigin` / CP-FALSIFY (`roxabi-boilerplate-cf`).
- Deleting path globs without a green classifier.
- Full natural-language claim inference from SC prose.

## Premise Validity

**Success in 6 months:** `/code-review` control spawn for fail-closed/authz/SSoT work is driven by structured `claim:` tags ∩ Δ (with fail-closed spawn when tags are missing on control-shaped Δ). Path globs remain as a safety net until a classifier is proven green; deleting them without that proof fails priced oracles. Spec authors tag control SCs in the template; omitting tags does not skip adversarial/security-class coverage.

**Failure in 6 months:** after ship, roster still effectively keys only off filename globs, or authors can skip control agents by omitting claim words / leaving tags off control-shaped Δ. Observable: green review with no adversarial/security-class spawn on a priced fail-closed Δ that never hit `**/auth/**`.

**Simplest alternative:** keep path-glob roster forever and document “put fail-closed code under `**/auth/**`”.

**Why not simplest:** control quality tracks **priced claim**, not directory layout. Path-only spawn was the known #417 gap; forcing layout to match globs is steerable and does not close “omit claim → skip”.

## Complexity

**Tier: F-lite** — from `size:F-lite`. Clear single-domain slice (spec template + `/code-review` spawn + tests); oracle work already landed; no new architectural unknown beyond claim-tag parsing and fail-closed missing-tag behavior.

Signals observed:
- Issue label `size:F-lite`.
- Touches `/spec` template + `/code-review` dispatch (+ tests); ¬oracle redesign.
- Deferred slice of approved #417 spec (U5 / claim 3) with explicit acceptance draft.
