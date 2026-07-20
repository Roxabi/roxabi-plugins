---
title: "Plan: Source-agnostic /promote (Model B) — trunk release.model + generated auto-release workflow"
issue: 371
spec: artifacts/specs/371-source-agnostic-promote-spec.mdx
complexity: 7/10
tier: F-full
generated: 2026-07-19
---

## Summary

40 source-grounded micro-tasks (6 slices, strict RED→GREEN TDD) delivering trunk release mode: `release.model` config plumbing → per-repo generated `auto-release.yml` (a THIN workflow invoking the sole orchestrator `auto-release.sh`, which reuses `price.sh`+`finalize.ts` — no second copy) → PR-path trunk guard → double-writer guards (`/checkup` + `/promote` refuse) → docs → roxabi-plugins dogfood swap. Decomposed by 6 parallel agents grounded in real source, synthesized into 9 waves (max 9 ∥), adversarially critiqued (5 findings; 4 applied, 1 rejected-after-web-verification + its actionlint gate adopted).

*(Forge-chart sidecars deferred — forge generator not wired this session.)*

## Plan decisions & corrections (applied)

- **9b-core extraction (spec's open `/plan` decision):** author `plugins/dev-core/skills/promote/auto-release.sh` as the **single** orchestration source (parentCount, price.sh derive, empty short-circuit, finalize.ts classify, reconcile loop); `generateAutoReleaseYml` emits a **thin** workflow that invokes it. No re-implementation of price.sh/finalize.ts logic → satisfies "no second copy".
- **Critique #1 (HIGH, applied):** S2-T2 derive/classify assertions retargeted onto `auto-release.sh` (not the YAML) — resolves the T2/T5 mutual-exclusivity.
- **Critique #2 (MED, applied):** S4-T5 uses `spawnSync` from `node:child_process`, not `Bun.spawnSync` (vitest runs under node).
- **Critique #3 (MED, REJECTED after web verification):** `queue: max` **is** a valid GitHub Actions concurrency key (GA 2026-05-07; valid only with `cancel-in-progress: false` — exactly our combo). Adopted its secondary suggestion → **new S2-T11**: actionlint gate over the emitted YAML (presence≠validity / generator-output-blind-spot mitigation).
- **Critique #4 (LOW, applied):** dropped S1-T9 (redundant `stack.yml.example` key edit); S5-T3 is sole authority.
- **Critique #5 (LOW, applied):** S4-T6 reads model via full `yq → python3 → default` fallback chain (guard must not go inert on CI without yq).

## Consistency Report

- Success Criteria covered: **20 / 20** (0 uncovered).
- Untraced tasks: **0**.
- Net task count: 40 (start 40 − S1-T9 + S2-T11).

## Agents

| Instance | Tasks | Σ ops | Cap |
|---|---|---|---|
| tester-A | S1-T1,S1-T2,S1-T3,S3-T1 | 12 | split (≤4 tasks/inst enforced) |
| tester-B | S2-T1,S2-T2,S2-T7 | 9 | split (≤4 tasks/inst enforced) |
| tester-C | S2-T4,S2-T6,S6-T5 | 10 | split (≤4 tasks/inst enforced) |
| tester-D | S4-T5,S4-T1,S4-T3 | 9 | split (≤4 tasks/inst enforced) |
| tester-E | S5-T1,S3-T3,S5-T4,S4-T8 | 9 | split (≤4 tasks/inst enforced) |
| backend-A | S1-T4,S1-T5,S1-T6,S1-T7 | 12 | split (≤4 tasks/inst enforced) |
| backend-B | S1-T8,S2-T3,S2-T5 | 13 | split (≤4 tasks/inst enforced) |
| backend-C | S4-T2,S2-T8,S4-T4 | 9 | split (≤4 tasks/inst enforced) |
| devops-A | S3-T2,S1-T10 | 6 | within caps |
| devops-B | S4-T6,S2-T9,S2-T10 | 7 | split (≤4 tasks/inst enforced) |
| devops-C | S6-T1,S6-T2,S6-T3,S6-T4 | 10 | split (≤4 tasks/inst enforced) |
| doc-writer-A | S4-T7,S5-T2,S5-T3 | 7 | within caps |

12 instances (5 tester, 3 backend-dev, 3 devops, 1 doc-writer). All ≤4 tasks/instance, max 13 ops (backend-B) — no 50-ops breach.

## Wave Structure

9 waves, max 9 parallel agents. Critical path: S1 config → S2 generator/orchestrator → S6 dogfood atomic gate. S3 (PR-path) + S5 (docs) run off the critical path.

| Wave | Trigger | Tasks |
|---|---|---|
| 1 | No dependencies — RED tests + independent scaffolds start immediately | S1-T1 · S1-T2 · S1-T3 · S2-T4 · S3-T1 · S4-T5 · S4-T7 · S5-T1 |
| 2 | Wave-1 RED tests exist; independent GREEN edits proceed | S1-T4 · S1-T5 · S3-T2 · S4-T6 · S5-T2 · S5-T3 |
| 3 | WorkflowOpts.release field + parser land; generator-facing RED tests … | S1-T6 · S1-T7 · S2-T1 · S2-T7 · S3-T3 · S5-T4 |
| 4 | StackInfo.release + generators land; core-reuse RED + drift wiring + … | S1-T8 · S2-T2 · S4-T1 |
| 5 | S1 plumbing complete; generator GREEN + copy-sync gate + N10 GREEN | S1-T10 · S2-T3 · S4-T2 |
| 6 | generateAutoReleaseYml exists; orchestrator + writer + N11 RED + dogf… | S2-T5 · S2-T8 · S4-T3 · S6-T1 |
| 7 | orchestrator + writer land; recovery fixture, S2 copy-sync, N11 GREEN… | S2-T6 · S2-T9 · S4-T4 · S6-T2 · S6-T3 |
| 8 | All GREEN in place; slice-level regression gates + dogfood fidelity d… | S2-T10 · S4-T8 · S6-T4 · S2-T11 |
| 9 | All slices merged; final dogfood atomicity + no-regression gate | S6-T5 |

### Budget — per agent instance

| Instance | Tasks | Σ ops | Split? |
|---|---|---|---|
| tester-A | S1-T1,S1-T2,S1-T3,S3-T1 | 12 | split done (cap enforced) |
| tester-B | S2-T1,S2-T2,S2-T7 | 9 | split done (cap enforced) |
| tester-C | S2-T4,S2-T6,S6-T5 | 10 | split done (cap enforced) |
| tester-D | S4-T5,S4-T1,S4-T3 | 9 | split done (cap enforced) |
| tester-E | S5-T1,S3-T3,S5-T4,S4-T8 | 9 | split done (cap enforced) |
| backend-A | S1-T4,S1-T5,S1-T6,S1-T7 | 12 | split done (cap enforced) |
| backend-B | S1-T8,S2-T3,S2-T5 | 13 | split done (cap enforced) |
| backend-C | S4-T2,S2-T8,S4-T4 | 9 | split done (cap enforced) |
| devops-A | S3-T2,S1-T10 | 6 | — |
| devops-B | S4-T6,S2-T9,S2-T10 | 7 | split done (cap enforced) |
| devops-C | S6-T1,S6-T2,S6-T3,S6-T4 | 10 | split done (cap enforced) |
| doc-writer-A | S4-T7,S5-T2,S5-T3 | 7 | — |

## Micro-Tasks

### S1 — Config schema + TS plumbing

| Task | Phase | Agent | Subject | Description | Files | Verify | Trace |
|---|---|---|---|---|---|---|---|
| S1-T1 | RED | tester | parser | RED: add failing tests in parse-stack-yml.test.ts asserting parseStackYml(text).release reads {model,component} from a `release:` block — model 'trun… | parse-stack-yml.test.ts | `grep -q "release" plugins/dev-core/skills/shared/__tests__/parse-stack-yml.test…` | N1,N2,N3 / SC:threads parser |
| S1-T2 | RED | tester | opts | RED: add failing tests in workflows.test.ts. (a) normalizeWorkflowOpts (import from '../workflows/workflow-types') returns release defaulted to { mod… | workflows.test.ts | `grep -q "release" plugins/dev-core/skills/shared/__tests__/workflows.test.ts &&…` | N1,N3 / SC:normalizeWorkflowOpts default, Required<WorkflowOpts> |
| S1-T3 | RED | tester | stackinfo | RED: add a failing test in doctor.test.ts asserting readStackYml() surfaces a release passthrough on StackInfo. readStackYml reads on-disk '.claude/s… | doctor.test.ts | `grep -q "release" plugins/dev-core/skills/checkup/__tests__/doctor.test.ts && !…` | N3 / SC:threads StackInfo |
| S1-T4 | GREEN | backend-dev | parser | GREEN: implement release parsing in parse-stack-yml.cjs. Add a parseRelease(text) helper (mirror parseTestingKey/parseCiMerge block-scoping on `/^rel… | parse-stack-yml.cjs | `bunx vitest run plugins/dev-core/skills/shared/__tests__/parse-stack-yml.test.ts` | N1,N2,N3 / SC:threads parser |
| S1-T5 | GREEN | backend-dev | types | GREEN: in workflow-types.ts add optional field `release?: { model: 'staging-train' | 'trunk'; component: string }` to the WorkflowOpts interface, and… | workflow-types.ts | `grep -q "release" plugins/dev-core/skills/shared/workflows/workflow-types.ts &&…` | N3 / SC:normalizeWorkflowOpts default, Required<WorkflowOpts> |
| S1-T6 | GREEN | backend-dev | generators | GREEN: in workflow-generators.ts extend the workflowOptsFromStack `stack` param type with `release?: { model?: string; component?: string }` and pass… | workflow-generators.ts | `bunx vitest run plugins/dev-core/skills/shared/__tests__/workflows.test.ts` | N1,N3 / SC:workflowOptsFromStack→WorkflowOpts.release |
| S1-T7 | GREEN | backend-dev | stackinfo | GREEN: in doctor-shared.ts add `release: { model: string; component: string | null } | null` to the StackInfo interface (after `unit`), populate it i… | doctor-shared.ts | `grep -q "release" plugins/dev-core/skills/checkup/doctor-shared.ts && bunx vite…` | N3 / SC:threads StackInfo |
| S1-T8 | GREEN | backend-dev | wiring | GREEN: in workflow-drift.ts thread the release passthrough into the workflowOptsFromStack({...}) call (~line 42) — add `release: stack.release ?? und… | workflow-drift.ts | `grep -q "release" plugins/dev-core/skills/checkup/workflow-drift.ts && bun run …` | N3 / SC:threads workflowOptsFromStack |
| S1-T10 | RED-GATE | devops | copysync | RED-GATE: run the copy-sync propagation + full-slice green gate. `bun run sync:shared` copies edited workflow-types.ts + workflow-generators.ts canon… | workflow-types.ts, workflow-generators.ts | `bun run sync:shared && python3 tools/validate_plugins.py --check shared-sources…` | N3 / SC:copy-sync byte-equal, full suite green |

### S2 — Auto-release generator (N4, N5, N6, N18, W1–W7)

| Task | Phase | Agent | Subject | Description | Files | Verify | Trace |
|---|---|---|---|---|---|---|---|
| S2-T1 | RED | tester | generator-test | RED: add a `describe('generateAutoReleaseYml')` block to workflows.test.ts asserting the STATIC workflow contract (W1–W4 + baking). Add `generateAuto… | workflows.test.ts | `bunx vitest run plugins/dev-core/skills/shared/__tests__/workflows.test.ts 2>&1…` | N4, W1-W4; SC 'Generated workflow contains on:push:[main] and workflow_dispatch; contents:write; concurrency cancel-in-progress:false + queue:max; mint before checkout; fetch-depth:0 + token + git fetch --tags; COMPONENT baked' |
| S2-T2 | RED | tester | core-reuse-script | RED (core-reuse on the SCRIPT): assert the W5-W7 derive/classify/reconcile contract lives in the ORCHESTRATOR SCRIPT `auto-release.sh` (NOT inlined in the YAML) — parentCount via `wc -w`, `price.sh COMPONENT M^1 M`, `--base-only`, empty short-circuit, `finalize.ts --is-promote true`, `for _ in 1 2 3` reconcile, `exit 1` on non-empty refuse. | auto-release.test.ts | `bunx vitest run plugins/dev-core/skills/promote/__tests__/auto-release.test.ts 2>&1…` | N4, W5-W7; SC 'parentCount via wc-w, DERIVED=price.sh COMPONENT M^1 M, BASE=price.sh --base-only, reuses finalize.ts (no second copy of derive/classify/reconcile)' |
| S2-T3 | GREEN | backend-dev | generator | GREEN: implement and export `generateAutoReleaseYml(opts: WorkflowOpts): string` in workflow-generators.ts, mirroring `generateAutoMergeYml` (~line 1… | workflow-generators.ts | `bunx vitest run plugins/dev-core/skills/shared/__tests__/workflows.test.ts && b…` | N4, N6, W1-W7; SC 'generateAutoReleaseYml exists ... COMPONENT baked ... reuses finalize.ts' |
| S2-T4 | RED | tester | fixtures | RED: add derivation fixture suite `plugins/dev-core/skills/promote/__tests__/auto-release.test.ts` reusing the synthetic-git-fixture harness pattern … | auto-release.test.ts | `bunx vitest run plugins/dev-core/skills/promote/__tests__/auto-release.test.ts …` | W5-W7; SC runtime fixtures '2-parent→tag, 1-parent→exit1, empty→green-noop, drift→exit1, first→0.1.0' |
| S2-T5 | GREEN | backend-dev | orchestrator | GREEN: honour the DESIGN CONSTRAINT (reuse 9b core, NO second copy of derive/classify/reconcile). Extract the SKILL.md 9b derive→short-circuit-empty→… | auto-release.sh, workflow-generators.ts | `bunx vitest run plugins/dev-core/skills/promote/__tests__/auto-release.test.ts …` | W5-W7 DESIGN CONSTRAINT 'reuse 9b core, no second copy'; SC 'reuses finalize.ts (no second copy of derive/classify/reconcile logic)' |
| S2-T6 | RED | tester | recovery | RED: add partial-failure recovery fixture to auto-release.test.ts — build a topology where the tag <comp>/vDERIVED already exists and points AT M (ta… | auto-release.test.ts | `bunx vitest run plugins/dev-core/skills/promote/__tests__/auto-release.test.ts …` | W7, D16; SC 'Partial-failure: tag present + release absent → reconcile creates the release (idempotent, no duplicate tag)' |
| S2-T7 | RED | tester | writer-test | RED: add a `writeWorkflows` test to workflows.test.ts asserting N18 wiring — with `release:{ model:'trunk', component:'roxabi-plugins' }` the emitted… | workflows.test.ts | `bunx vitest run plugins/dev-core/skills/shared/__tests__/workflows.test.ts -t '…` | N18; SC 'N4 wired into workflow-push.ts writer array so /init /ci-setup emit auto-release.yml when release.model==trunk' |
| S2-T8 | GREEN | backend-dev | writer | GREEN: wire N4 into the writer array. In workflow-push.ts add `generateAutoReleaseYml` to the `./workflow-generators` import (lines 8-14) and, inside… | workflow-push.ts | `bunx vitest run plugins/dev-core/skills/shared/__tests__/workflows.test.ts && b…` | N18; SC 'wired into workflow-push.ts writer array' |
| S2-T9 | REFACTOR | devops | copy-sync | REFACTOR/gate: propagate the edited copy-sync canonicals (workflow-generators.ts + workflow-push.ts) to their dev-init @generated copies by running `… | workflow-generators.ts, workflow-push.ts | `bun run sync:shared && python3 tools/validate_plugins.py --check shared-sources…` | N5; SC 'copy-synced byte-equal to dev-init (validate_plugins shared-sources-sync green; shared-sources.json + biome overrides set-equality holds)' |
| S2-T10 | RED-GATE | devops | gate | RED-GATE: full regression + lint sentinel. Run the whole vitest suite and biome to confirm S2 added no regression to the staging-train path and the n… | workflow-generators.ts, auto-release.sh | `bun run test && bunx biome check .` | SC 'Full existing test suite (vitest + shell fixtures) passes unchanged — no regression to staging-train path' |
| S2-T11 | RED-GATE | devops | actionlint | NEW (from critique #3 secondary): validate the EMITTED workflow YAML for GitHub-Actions schema validity, not just byte-presence. Add a test/gate that… | , auto-release.yml | `(command -v actionlint >/dev/null && printf '%s' "$(bun -e "import {generateAut…` | W2 validity / generator-output-blind-spot mitigation |

### S3 — PR-path trunk guard

| Task | Phase | Agent | Subject | Description | Files | Verify | Trace |
|---|---|---|---|---|---|---|---|
| S3-T1 | RED | tester | gate-test | In plugins/dev-core/skills/promote/__tests__/release-gate.test.ts add a new failing describe block 'N7/N8 — trunk PR-path early-green (spec #371 S3)'… | release-gate.test.ts | `! bunx vitest run plugins/dev-core/skills/promote/__tests__/release-gate.test.ts` | N7, N8; SC 'PR path: model==trunk → early-green' |
| S3-T2 | GREEN | devops | gate-yaml | In .github/workflows/release-consistency.yml Gate step (run: block, env at ~line 61): (a) add a `read_model()` bash helper mirroring `read_component(… | release-consistency.yml | `bunx vitest run plugins/dev-core/skills/promote/__tests__/release-gate.test.ts …` | N7, N8; SC 'model==trunk → early-green all PRs' |
| S3-T3 | RED-GATE | tester | regression | Regression + N9 sentinel: confirm the staging-train gate fixtures produce identical outcomes and the push-path floor (D14) block is untouched. Run th… | release-consistency.yml, release-gate.test.ts | `bun run test 2>&1 | tail -3 && grep -q 'push / workflow_dispatch path (D14)' .g…` | N9; SC 'staging-train path behaviorally unchanged'; SC 'push-path floor unchanged' |

### S4 — Double-writer guards (N10, N11, N17)

| Task | Phase | Agent | Subject | Description | Files | Verify | Trace |
|---|---|---|---|---|---|---|---|
| S4-T1 | RED | tester | collision | In workflow-drift.test.ts add a nested describe('release-model guards — N10 release-please collision') with three RED cases (write fixtures via the e… | workflow-drift.test.ts | `bunx vitest run plugins/dev-core/skills/checkup/__tests__/workflow-drift.test.t…` | N10; SC 'checkup fails when model==trunk ∧ release-please.yml present' |
| S4-T2 | GREEN | backend-dev | collision | Implement the N10 bespoke fail in checkWorkflowDrift() (workflow-drift.ts): AFTER the warn-only digest loop, read the release model from the stack (v… | workflow-drift.ts | `bunx vitest run plugins/dev-core/skills/checkup/__tests__/workflow-drift.test.t…` | N10; SC 'checkup fails when model==trunk ∧ release-please.yml present' |
| S4-T3 | RED | tester | auto-release | In workflow-drift.test.ts add describe('release-model guards — N11 auto-release missing/drifted') with RED cases: (a) stack model==trunk + component … | workflow-drift.test.ts | `bunx vitest run plugins/dev-core/skills/checkup/__tests__/workflow-drift.test.t…` | N11; SC 'checkup fails when model==trunk ∧ auto-release.yml absent-or-drifted (real fail not warn)' |
| S4-T4 | GREEN | backend-dev | auto-release | Implement the N11 bespoke fail in checkWorkflowDrift() (workflow-drift.ts): when model==='trunk', compute the expected workflow via generateAutoRelea… | workflow-drift.ts | `bunx vitest run plugins/dev-core/skills/checkup/__tests__/workflow-drift.test.t…` | N11; SC 'checkup fails when model==trunk ∧ auto-release.yml absent-or-drifted' |
| S4-T5 | RED | tester | preflight | Create preflight.test.ts (RED) spawning preflight.sh in a temp git dir. Cases: (a) stack.yml with `release:\n model: trunk\n component: x` → stdout c… | preflight.test.ts | `bunx vitest run plugins/dev-core/skills/promote/__tests__/preflight.test.ts 2>&…` | N17; SC '/promote (and preflight.sh) refuses/no-ops when model==trunk' |
| S4-T6 | GREEN | devops | preflight | Add the trunk guard to preflight.sh (N17) as the FIRST executable block, BEFORE `git fetch origin staging main` (a trunk repo may have no staging bra… | preflight.sh | `grep -q 'status=trunk_mode' plugins/dev-core/skills/promote/preflight.sh && bun…` | N17; SC '/promote (and preflight.sh) refuses/no-ops when model==trunk' |
| S4-T7 | GREEN | doc-writer | skill | In promote SKILL.md (N17 doc side — the full release.model section is S5/N12, this is only the guard row), add a Pre-flight table row so /promote ref… | SKILL.md | `grep -q 'release.model==trunk' plugins/dev-core/skills/promote/SKILL.md && grep…` | N17; SC '/promote refuses/no-ops when model==trunk' |
| S4-T8 | RED-GATE | tester | regression | RED-GATE: run the full existing suite + lint to prove the S4 guards introduced no regression to the staging-train path and no lint drift on the edite… | workflow-drift.ts, preflight.sh | `bun run test 2>&1 | tail -5 && bun run lint 2>&1 | tail -3 && bun run typecheck…` | N10,N11,N17; SC 'full existing suite passes unchanged' |

### S5 — Docs (N12 SKILL.md release.model section, N13 stack.yml.example release.model key)

| Task | Phase | Agent | Subject | Description | Files | Verify | Trace |
|---|---|---|---|---|---|---|---|
| S5-T1 | RED | tester | sentinel | Add a RED sentinel vitest that guards the S5 docs contract. Create plugins/dev-core/skills/promote/__tests__/release-model-docs.test.ts. It reads pro… | release-model-docs.test.ts | `! bun run test plugins/dev-core/skills/promote/__tests__/release-model-docs.tes…` | S5 SC 'SKILL.md release.model section grep-checkable for all four concepts'; N12, N13 |
| S5-T2 | GREEN | doc-writer | skill | GREEN: add a `## Trunk mode — `release.model`` section to plugins/dev-core/skills/promote/SKILL.md (place it after Step 1a — Release guards, since it… | SKILL.md | `f=plugins/dev-core/skills/promote/SKILL.md && grep -q 'merge-commit' "$f" && gr…` | N12; S5 SC 'SKILL.md release.model section grep-checkable for all four concepts' |
| S5-T3 | GREEN | doc-writer | example | GREEN: add the `release.model` key to the release block in plugins/dev-core/stack.yml.example (block at lines 71-74). Insert ` model: staging-train` … | stack.yml.example | `grep -qE '^ model:[[:space:]]+staging-train' plugins/dev-core/stack.yml.example…` | N13; S5 SC 'stack.yml.example has the key' |
| S5-T4 | GREEN | tester | gate | GREEN-GATE: confirm the S5 sentinel is now green and nothing else regressed. Run the sentinel test file, then the promote suite. No code change expec… | release-model-docs.test.ts, SKILL.md, stack.yml.example | `bun run test plugins/dev-core/skills/promote/__tests__/release-model-docs.test.…` | S5 SC (docs); N12, N13 |

### S6 — Dogfood swap (single atomic merge): roxabi-plugins onto release.model:trunk with generated auto-release.yml and release-please trio deleted, all in one merge (N14, N15, N16)

| Task | Phase | Agent | Subject | Description | Files | Verify | Trace |
|---|---|---|---|---|---|---|---|
| S6-T1 | GREEN | devops | stack | In the tracked file .claude/stack.yml add a top-level `release:` block (none exists today) with `model: trunk`, `component: roxabi-plugins`, and `ver… | stack.yml | `grep -q '^release:' .claude/stack.yml && grep -q 'model: trunk' .claude/stack.y…` | N14; SC dogfood (stack.yml sets model:trunk+component+version_files) |
| S6-T2 | GREEN | devops | workflow | Generate roxabi-plugins' own .github/workflows/auto-release.yml by invoking the S2 generator generateAutoReleaseYml with roxabi-plugins opts (release… | auto-release.yml | `test -f .github/workflows/auto-release.yml && grep -q 'workflow_dispatch' .gith…` | N15; SC dogfood (auto-release.yml committed) |
| S6-T3 | GREEN | devops | cleanup | Delete the release-please trio (all three git-tracked): .github/workflows/release-please.yml, release-please-config.json (component roxabi-plugins, t… | release-please.yml, release-please-config.json, .release-pl… | `! test -e .github/workflows/release-please.yml && ! test -e release-please-conf…` | N16; SC dogfood (release-please trio deleted) |
| S6-T4 | GREEN | devops | fidelity | Verify the committed .github/workflows/auto-release.yml is byte-equal to the generator output for roxabi-plugins' live stack config — this is exactly… | auto-release.yml | `bun -e "import {generateAutoReleaseYml} from './plugins/dev-core/skills/shared/…` | N15, N11; SC dogfood (/checkup green — auto-release matches generator) |
| S6-T5 | RED-GATE | tester | regression | RED-GATE regression + atomicity sentinel. Confirm (a) the full existing test suite and typecheck pass unchanged after the swap (no regression to the … | stack.yml, auto-release.yml | `bun run test && bun run typecheck && test -f .github/workflows/auto-release.yml…` | SC 'release-please trio deleted in one merge'; SC 'full existing test suite passes unchanged' |

## Task Seeding Blueprint

<!-- Used by /implement to seed TaskCreate calls. T{n} | agent-instance | blockedBy | subject.
     blockedBy refs T-numbers within this list. Seed in wave order; within a wave rows are parallel. -->

### Wave 1 — No dependencies — RED tests + independent scaffolds start immediately

| Task | Agent instance | blockedBy | Subject |
|---|---|---|---|
| S1-T1 | tester-A | — | parser RED (release passthrough) |
| S1-T2 | tester-A | — | opts RED (normalizeWorkflowOpts default) |
| S1-T3 | tester-A | — | StackInfo RED (readStackYml.release) |
| S2-T4 | tester-C | — | runtime derivation fixtures (5 topologies) |
| S3-T1 | tester-A | — | gate RED (N7/N8 read_model+ordering) |
| S4-T5 | tester-D | — | preflight RED (trunk_mode) |
| S4-T7 | doc-writer-A | — | SKILL.md pre-flight guard row |
| S5-T1 | tester-E | — | docs sentinel RED (4 concepts + example key) |

### Wave 2 — Wave-1 RED tests exist; independent GREEN edits proceed

| Task | Agent instance | blockedBy | Subject |
|---|---|---|---|
| S1-T4 | backend-A | S1-T1 | parse-stack-yml.cjs parseRelease |
| S1-T5 | backend-A | S1-T2 | WorkflowOpts.release + normalize default |
| S3-T2 | devops-A | S3-T1 | release-consistency.yml read_model + early-green |
| S4-T6 | devops-B | S4-T5 | preflight.sh trunk guard (first block) |
| S5-T2 | doc-writer-A | S5-T1 | SKILL.md trunk-mode section |
| S5-T3 | doc-writer-A | S5-T1 | stack.yml.example model key (authoritative comment; supersedes S1-T9) |

### Wave 3 — WorkflowOpts.release field + parser land; generator-facing RED tests + downstre…

| Task | Agent instance | blockedBy | Subject |
|---|---|---|---|
| S1-T6 | backend-A | S1-T2,S1-T5 | workflowOptsFromStack release passthrough |
| S1-T7 | backend-A | S1-T3,S1-T4 | doctor-shared StackInfo.release |
| S2-T1 | tester-B | S1-T5 | generateAutoReleaseYml static-contract RED (W1-W4) |
| S2-T7 | tester-B | S1-T5 | writeWorkflows N18 RED |
| S3-T3 | tester-E | S3-T2 | gate regression + N9 floor sentinel |
| S5-T4 | tester-E | S5-T2,S5-T3 | docs green-gate |

### Wave 4 — StackInfo.release + generators land; core-reuse RED + drift wiring + S4 collisi…

| Task | Agent instance | blockedBy | Subject |
|---|---|---|---|
| S1-T8 | backend-B | S1-T6,S1-T7 | workflow-drift.ts release wiring |
| S2-T2 | tester-B | S2-T1 | W5-W7 derive/classify/reconcile RED |
| S4-T1 | tester-D | S1-T7 | N10 release-please collision RED |

### Wave 5 — S1 plumbing complete; generator GREEN + copy-sync gate + N10 GREEN

| Task | Agent instance | blockedBy | Subject |
|---|---|---|---|
| S1-T10 | devops-A | S1-T5,S1-T6,S1-T7,S1-T8 | S1 copy-sync + full-suite gate |
| S2-T3 | backend-B | S2-T1,S2-T2,S1-T5,S1-T6 | generateAutoReleaseYml GREEN |
| S4-T2 | backend-C | S4-T1,S1-T7 | N10 collision fail GREEN |

### Wave 6 — generateAutoReleaseYml exists; orchestrator + writer + N11 RED + dogfood stack

| Task | Agent instance | blockedBy | Subject |
|---|---|---|---|
| S2-T5 | backend-B | S2-T3,S2-T4 | auto-release.sh orchestrator + generator reconcile |
| S2-T8 | backend-C | S2-T3,S2-T7 | workflow-push.ts writer wiring GREEN |
| S4-T3 | tester-D | S2-T3 | N11 auto-release absent/drift RED |
| S6-T1 | devops-C | S1-T10 | dogfood .claude/stack.yml → trunk |

### Wave 7 — orchestrator + writer land; recovery fixture, S2 copy-sync, N11 GREEN, dogfood …

| Task | Agent instance | blockedBy | Subject |
|---|---|---|---|
| S2-T6 | tester-C | S2-T4,S2-T5 | partial-failure recovery fixture (D16) |
| S2-T9 | devops-B | S2-T3,S2-T5,S2-T8 | S2 copy-sync byte-equal gate |
| S4-T4 | backend-C | S4-T3,S4-T2,S2-T3 | N11 auto-release fail GREEN |
| S6-T2 | devops-C | S2-T3,S6-T1 | generate committed auto-release.yml |
| S6-T3 | devops-C | S6-T1 | git rm release-please trio |

### Wave 8 — All GREEN in place; slice-level regression gates + dogfood fidelity diff

| Task | Agent instance | blockedBy | Subject |
|---|---|---|---|
| S2-T10 | devops-B | S2-T3,S2-T5,S2-T8,S2-T9 | S2 full-suite + biome gate |
| S4-T8 | tester-E | S4-T2,S4-T4,S4-T6 | S4 full-suite + lint gate |
| S6-T4 | devops-C | S6-T2 | auto-release.yml generator-fidelity diff (N11 invariant) |
| S2-T11 | devops-B | S2-T3 | actionlint |

### Wave 9 — All slices merged; final dogfood atomicity + no-regression gate

| Task | Agent instance | blockedBy | Subject |
|---|---|---|---|
| S6-T5 | tester-C | S6-T1,S6-T2,S6-T3,S6-T4,S2-T10,S4-T8,S3-T3 | dogfood atomic-swap + full-suite regression |

## Task IDs

<!-- Generated by /plan Step 6b. Used by /implement to re-attach tasks after a session restart / compact. -->
- S1-T1: #12 — parser (RED)
- S1-T2: #13 — opts (RED)
- S1-T3: #14 — stackinfo (RED)
- S2-T4: #15 — fixtures (RED)
- S3-T1: #16 — gate-test (RED)
- S4-T5: #17 — preflight (RED)
- S4-T7: #18 — skill (GREEN)
- S5-T1: #19 — sentinel (RED)
- S1-T4: #20 — parser (GREEN)
- S1-T5: #21 — types (GREEN)
- S3-T2: #22 — gate-yaml (GREEN)
- S4-T6: #23 — preflight (GREEN)
- S5-T2: #24 — skill (GREEN)
- S5-T3: #25 — example (GREEN)
- S1-T6: #26 — generators (GREEN)
- S1-T7: #27 — stackinfo (GREEN)
- S2-T1: #28 — generator-test (RED)
- S2-T7: #29 — writer-test (RED)
- S3-T3: #30 — regression (RED-GATE)
- S5-T4: #31 — gate (GREEN)
- S1-T8: #32 — wiring (GREEN)
- S2-T2: #33 — core-reuse-script (RED)
- S4-T1: #34 — collision (RED)
- S1-T10: #35 — copysync (RED-GATE)
- S2-T3: #36 — generator (GREEN)
- S4-T2: #37 — collision (GREEN)
- S2-T5: #38 — orchestrator (GREEN)
- S2-T8: #39 — writer (GREEN)
- S4-T3: #40 — auto-release (RED)
- S6-T1: #41 — stack (GREEN)
- S2-T6: #42 — recovery (RED)
- S2-T9: #43 — copy-sync (REFACTOR)
- S4-T4: #44 — auto-release (GREEN)
- S6-T2: #45 — workflow (GREEN)
- S6-T3: #46 — cleanup (GREEN)
- S2-T10: #47 — gate (RED-GATE)
- S2-T11: #48 — actionlint (RED-GATE)
- S4-T8: #49 — regression (RED-GATE)
- S6-T4: #50 — fidelity (GREEN)
- S6-T5: #51 — regression (RED-GATE)
