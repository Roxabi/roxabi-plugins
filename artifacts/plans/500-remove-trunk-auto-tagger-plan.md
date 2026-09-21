---
title: "Plan: Remove the trunk auto-tagger — a release is an explicit act"
issue: 500
adr: docs/architecture/adr/021-release-is-an-explicit-act.md
complexity: 4/10
tier: F-lite
generated: "2026-09-21T00:00:00+02:00"
---

## Summary

Delete the merge-to-main tagger and everything that generates, guards or documents
it. `release.model: trunk` keeps its branch-flow meaning; it stops implying a
release trigger. Add a hand-written, verify-only `release.yml` on
`push: tags: roxabi-plugins/v*`. `price.sh` and `lib/finalize.ts` are untouched —
they remain the staging-train deriver for spark, metalyde, factory and intel.

Net: ~1 000 lines removed, ~25 added. No fleet repo changes behaviour; only
roxabi-plugins stops auto-tagging.

## Architecture

### What the key means, before and after

| Concern | before | after |
|---|---|---|
| no `staging` branch, `feature → main` | `release.model: trunk` | **unchanged** |
| `triggerBranches() → [main]` | `release.model: trunk` | **unchanged** |
| `/R-promote` refuses `--finalize`, `preflight.sh` no-ops | `release.model: trunk` | **unchanged** (rationale restated) |
| release-gate early-green on the PR path | `release.model: trunk` | **unchanged** |
| N10 — stray `release-please.yml` is a split brain | `release.model: trunk` | **unchanged** |
| **tag + GitHub Release cut at merge** | `release.model: trunk` | **removed** |
| N11 — `auto-release.yml` must exist and match the generator | `release.model: trunk` | **removed** |
| #375 — trunk requires dev-core vendored under `plugins/` | `release.model: trunk` | **removed** (nothing invokes the script) |

### Release flow, after

```
git tag -a roxabi-plugins/vX.Y.Z -m "…"
git push origin roxabi-plugins/vX.Y.Z
  └→ release.yml: annotated? · rev-list -n1 TAG == SHA? · SHA ancestor of main?
       └→ gh release create --verify-tag --generate-notes
```

### File × Function Map

| File | Action |
|---|---|
| `plugins/dev-core/skills/promote/auto-release.sh` | **delete** (168 l.) |
| `plugins/dev-core/skills/promote/__tests__/auto-release.test.ts` | **delete** (482 l.) |
| `plugins/dev-core/skills/shared/__tests__/auto-release-actionlint.test.ts` | **delete** (actionlint + N11 byte gate) |
| `plugins/dev-core/skills/shared/workflows/workflow-generators.ts` | drop `generateAutoReleaseYml` + `TRUNK_AUTO_RELEASE_SCRIPT` |
| `plugins/dev-core/skills/shared/workflows/workflow-push.ts` | drop `trunkScriptRefusal`, `assertTrunkScriptLocal`, the remote contents-API guard, the N18 emission at `:159-162`, the `generateAutoReleaseYml` import |
| `plugins/dev-core/skills/shared/workflows/workflow-types.ts` | `WorkflowRelease.component` doc no longer says "baked into auto-release.yml"; `ReleaseModel` doc drops "version+tag+release derived on every merge" |
| `plugins/dev-core/skills/dev-checkup/workflow-drift.ts` | drop N11 (`release-model:auto-release`); keep N10 |
| `plugins/dev-core/skills/dev-checkup/__tests__/workflow-drift.test.ts` | drop the three N11 cases; keep the N10 case |
| `plugins/dev-core/skills/shared/__tests__/workflows.test.ts` | drop `emits auto-release.yml…` + the trunk-refusal case; **keep** `triggerBranches` and `resolveRelease` cases |
| `plugins/dev-core/skills/shared/__tests__/workflow-push.test.ts` | delete the #375 guard suite |
| `plugins/dev-core/skills/promote/SKILL.md` | rewrite `## Trunk mode` (4 bullets → 2); restate the Step 9.0 refusal rationale; drop the merge-commit/D3 requirement |
| `plugins/dev-core/skills/promote/__tests__/release-model-docs.test.ts` | delete the `(a)` merge-commit, `(c)` D18-no-op and `(d)` workflow_dispatch sentinels; keep the section + `release.model` + `stack.yml.example` cases |
| `plugins/dev-core/skills/ci-setup/cookbooks/workflows.md` | drop the trunk-mode note and `--release-component` "required when model is trunk" |
| `.github/workflows/auto-release.yml` | **delete** |
| `.github/workflows/release.yml` | **new**, ~25 l., hand-written |
| `plugins/dev-core/README.md`, `CONTRIBUTING.md`, `docs/release-convention.md` | drop auto-release references |
| `~/projects/docs/release-convention.md` | fleet roster: split trunk into trunk-manual (roxabi-plugins) / trunk-auto (silex-plugins) |

**Not touched:** `price.sh`, `lib/finalize.ts`, `preflight.sh`, `release-consistency.yml`,
`scripts/provision-release-gate.sh`, and every existing tag.

## Task IDs

- T1: Delete `auto-release.sh` + its three suites → devops
- T2: Strip the generator — `generateAutoReleaseYml`, `TRUNK_AUTO_RELEASE_SCRIPT`, N18 emission, #375 guards → devops
- T3: Drop N11 from `workflow-drift.ts` + its cases; keep N10 → devops
- T4: Write `.github/workflows/release.yml` (verify-only, tag-triggered) → devops
- T5: Delete `.github/workflows/auto-release.yml` and `release.model` prose that promises a tagger → devops
- T6: Rewrite `promote/SKILL.md` `## Trunk mode` + Step 9.0 rationale → doc-writer
- T7: Prune `release-model-docs.test.ts` sentinels (delete, never re-pin) → doc-writer
- T8: Update `ci-setup/cookbooks/workflows.md`, `dev-core/README.md`, `CONTRIBUTING.md`, `docs/release-convention.md` → doc-writer
- T9: Update the fleet roster in `~/projects/docs/release-convention.md` → doc-writer

### Task 1: Delete the tagger
- **Files:** `plugins/dev-core/skills/promote/auto-release.sh`, `__tests__/auto-release.test.ts`, `plugins/dev-core/skills/shared/__tests__/auto-release-actionlint.test.ts`
- **Verify:** `grep -r auto-release plugins/dev-core --include='*.ts' --include='*.sh'` returns nothing
- **Instance:** devops

### Task 2: Strip the generator
- **Files:** `skills/shared/workflows/workflow-generators.ts`, `workflow-push.ts`, `workflow-types.ts`
- **Note:** `writeWorkflows`/`pushWorkflows` keep every other workflow; only the
  `if (o.release.model === 'trunk')` push at `workflow-push.ts:159-162` and the two
  guards go. `triggerBranches` and `resolveRelease` stay — they encode branch flow.
- **Verify:** `cd plugins/dev-core && bunx vitest run skills/shared/__tests__/workflows.test.ts skills/shared/__tests__/workflow-push.test.ts`
- **Instance:** devops

### Task 3: Drop N11
- **Files:** `skills/dev-checkup/workflow-drift.ts`, `__tests__/workflow-drift.test.ts`
- **Verify:** `bunx vitest run skills/dev-checkup/__tests__/workflow-drift.test.ts` — the N10 collision case still passes
- **Instance:** devops

### Task 4: The replacement workflow
- **File:** `.github/workflows/release.yml` (new)
- **Shape:** `on: push: tags: ['roxabi-plugins/v*']`, `permissions: contents: write`,
  one job: checkout `fetch-depth: 0` + `fetch-tags`, then
  `test "$(git cat-file -t "$GITHUB_REF_NAME")" = tag` ·
  `test "$(git rev-list -n 1 "$GITHUB_REF_NAME")" = "$GITHUB_SHA"` ·
  `git merge-base --is-ancestor "$GITHUB_SHA" origin/main` ·
  `gh release view "$GITHUB_REF_NAME" || gh release create "$GITHUB_REF_NAME" --verify-tag --generate-notes`
- **Verify:** `actionlint .github/workflows/release.yml`, then a real annotated tag
  push cutting the next release
- **Instance:** devops

### Task 6: Rewrite the trunk section
- **File:** `plugins/dev-core/skills/promote/SKILL.md`
- **Removes:** "Merge-commits required" (nothing derives from `M^1..M`), "Fires on
  every merge; empty is a green no-op" (false today, absent tomorrow), "Recovery via
  `workflow_dispatch`" (no workflow to dispatch)
- **Keeps, restated:** `--finalize` is refused under trunk because `/R-promote` is
  the *staging-train* tagger and a trunk repo has no promotion to finalize; the
  create-PR path stays open while a `staging` branch exists
- **Adds:** trunk releases are cut by pushing an annotated `<component>/vX.Y.Z` tag
- **Instance:** doc-writer

## Wave Structure

| Wave | PR | Agents | Tasks |
|---|---|---|---|
| A | tagger removal | devops | T1–T5 (atomic) |
| B | docs cutover | doc-writer ∥ doc-writer | T6–T7 ∥ T8–T9 |
| C | — | — | full suite + `actionlint`, then the first hand tag |

**Wave A is indivisible.** Splitting it opens a window where `main` is red or
self-destructive, three ways:

- `auto-release.yml` on `main` without `auto-release.sh` → the workflow fires on
  the next merge and dies `exit 127` (#375, the failure the resolvability guard
  exists to prevent).
- N11 **fails** when `release.model: trunk` and `auto-release.yml` is absent, so
  deleting the workflow without dropping N11 reds `/R-dev-checkup`.
- `auto-release-actionlint.test.ts` byte-asserts the committed `auto-release.yml`
  against `generateAutoReleaseYml`, so removing either side alone reds CI.

T1–T5 therefore land in one PR. Wave B is pure prose plus the sentinels that pin
it; T6–T7 (`SKILL.md` + `release-model-docs.test.ts`) and T8–T9 (cookbooks,
READMEs, fleet roster) touch disjoint files and run in parallel.

## Acceptance

- `grep -rn 'auto-release' --exclude-dir={.git,node_modules,artifacts,docs}` →
  matches only in `CHANGELOG.md` history and ADR-021
- `/R-dev-checkup` green on roxabi-plugins with `release.model: trunk` and no
  release workflow generated
- A merge to `main` cuts **no** tag and **no** release
- An annotated `roxabi-plugins/v5.1.0` push creates exactly one GitHub Release
- A lightweight tag, a moved tag, or a tag on a commit not reachable from `main`
  fails the workflow
- `bunx vitest run` green in `plugins/dev-core` with the staging-train suites
  (`price.test.ts`, `finalize.test.ts`, `preflight.test.ts`, `release-gate.test.ts`)
  unchanged

## Out of scope

- Amending the D18 bump map — ADR-021 §Refuse list
- A third `release.model` value
- Declaring `version` in the plugin manifests, or a `stable` channel
- Re-tagging or moving any existing tag
