---
title: "ADR-019: Plugin-owned falsify oracle (markdown is a report)"
description: >
  Executable run-falsify is the sole falsify oracle for τ≠S gates.
  Isolation = temp worktree. Proven record = falsify.json.
  Gate boolean = oracle_ok from --verify re-exec. parse-falsify demoted to ungated lint.
---

## Status

Accepted — 2026-08-21. Implements Roxabi/roxabi-plugins#417 Shape 1 (V1).

## Context

#416 shipped `parse-falsify.sh` and a thinner `/dev-review` roster. Gates still
measured **document shape** (`falsify_ok` from markdown tokens). Forged or
LLM-authored evidence could clear `/pr` and skip the tester without an executable
fail-under-absent → pass-under-restore of mapped unit/fast-integration tests.

## Decision

1. **Oracle ownership** — `plugins/dev-core/skills/pr/run-falsify.sh` is the sole
   executable falsify oracle for τ≠S. Consumer `test:falsify` / LLM `git stash` are
   not alternate oracles unless they exec this helper without swallowing non-zero.

2. **Isolation** — canonical API = **temp worktree / copy at HEAD**. Repo-global
   `git stash` is not the public API. Trap-backed in-place backup may exist only as
   an impl detail with restore guarantee.

3. **Proven record** — `artifacts/reviews/{N}-falsify.json` (`schema_version: "1"`)
   holds `head`, `runner_id`, `rows[]`, `oracle_ok`. Markdown `*-falsify.md` is an
   optional render, never a gate input.

4. **Gate boolean graph** — `/pr` refuse and `/dev-review` tester-skip read only
   **`oracle_ok`** from `run-falsify --verify` (full re-exec of mapped rows).
   Schema-parse of a pre-written green JSON alone → ¬`oracle_ok`.
   `falsify_ok` from `parse-falsify.sh` is removed from refuse/skip paths.
   `parse-falsify.sh` may remain as ungated markdown hygiene.

5. **Empty / all-exempt** — τ≠S with zero FAIL→PASS unit/FI rows (including
   all-exempt matrices) ⇒ `oracle_ok=false`.

6. **Roster (out of V1)** — claim-axis spawn is V2. V1 keeps structural path
   triggers for architect/devops/security-auditor.

## Consequences

- `/implement` Step 6b, `/pr` gather-state, and `/dev-review` must call the helper.
- Kit/boilerplate can later invoke the same script; not an AC of #417 V1.
- Verify cost may run 2–3× (implement + pr + review); same-`head` session cache is
  optional later — never a receipt-only bypass.

## References

- Issue #417 · Spec `artifacts/specs/417-plugin-owned-falsify-runner-spec.md`
- Analysis Shape 1 · Frame `artifacts/frames/417-plugin-owned-falsify-runner-frame.md`
