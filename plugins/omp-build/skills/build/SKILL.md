---
name: build
disable-model-invocation: true
argument-hint: '[#N | --spec <path>]'
description: OMP-only — grill then validate spec, then plan→impl→PR→review→reviewed→watch merge. Not host /dev.
version: 0.3.0
---

# Build

One cycle in this session. Grill and spec stay here (HITL). `run()` starts at plan.

`agent()` has no `cwd`. Isolation apply hits **session HEAD**. Implement never runs on the principal checkout.

## 1. Be in ω

Done when this dir is a worktree and `HEAD` is `<type>/<N>-<slug>`.

If not: tell the user to run `omp-wt` from the principal and stop. Do not grill. Do not implement.

## 2. Load the spec

Path: `--spec` in `$ARGUMENTS`, else `artifacts/specs/{N}-*-spec.md`.

If frontmatter `status: validated` → skip to 4.

## 3. Grill then spec

Read `skill://grilling` if it exists. Otherwise: one **frontier** per round — numbered questions, each with a recommended answer — then wait.

Subject = spec TL;DR, else issue title, else `$ARGUMENTS`.

Domain only: TL;DR, data model, acceptance, out of scope, invariants, CONTEXT terms. No stack, files, or API shapes.

Write `artifacts/specs/{N}-{slug}-spec.md` to `skill://build/SPEC.md`. Keep `issue:` and the filename slug. Set `status: draft`.

Done when that file has every required section and `status: draft`.

Ask: « Spec prêt — tape `validated` pour lancer le plan. »

Stop. Wait. Do not call `run()` until the user says `validated` (or an equivalent explicit confirm).

On confirm: set `status: validated`. Done when frontmatter is `validated`.

## 4. Plan onward

```javascript
const { run } = await import(`${env('HOME')}/.omp/plugins/node_modules/omp-build/skills/build/workflow.js`)
const result = await run({ issue, specPath, cwd })
```

| `result.status` | Action |
|---|---|
| `need-relaunch` | `omp --cwd <result.worktree>` then `/build #N`. Do not implement here. |
| `red` | Stop. Show review or land blocker (`reason`: ci-failed\|closed\|timeout). Leave the worktree. |
| `green` | PR merged (`reviewed` + watch). Print `result.cleanup` (remove ω from the principal). Never delete cwd from inside it. |

- Grill in this turn. Do not Skill() `grill-me`.
- Do not Skill() dev-core children.
- Do not `pipeline()` the SDLC chain.
- Review = sibling `reviewer` + `security-reviewer`. No nested `task`.
