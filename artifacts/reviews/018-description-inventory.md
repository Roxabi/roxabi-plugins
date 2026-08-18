---
title: "ADR-018 description inventory — axis 2"
status: review-complete
date: 2026-08-18
subject: plugins/dev-core/skills/*/SKILL.md
---

# ADR-018 description inventory — axis 2 (invocation budget)

Measured 2026-08-18 from repo source `plugins/dev-core/skills/*/SKILL.md` (32 files; `shared/` and `init/` have no skill frontmatter). No `SKILL.md` was edited.

**Method**

- `desc_chars` = Unicode length of the YAML `description` **scalar** after quote-stripping (not the file, not the `description: ` key). Em dash / `→` / `×` count as 1.
- `has_disable_model_invocation` = key present in frontmatter. **0 / 32** files set it (grep: no matches). All `false`.
- `trigger_phrases` = quoted `Triggers:` / `Triggers ` list in that scalar; `—` if absent. All 32 have a Triggers list (clarify uses `Triggers "` — no colon).
- `pipeline_class` = `chain-contract.md` class table when listed; else inferred from `/dev` Step 7 / `/ship` / the skill's own Chain Position. Inferred rows marked.
- `invoked_by_factory` = **yes** iff `/dev` or `/ship` actually `Skill()`s it (Step 7 map, bootstrap, `--cleanup-context`, or `/ship` steps). `/dev` lists `skill: "promote"` but Step 4 **always skips** and the map says never auto-triggered → **no**.
- `allowed_tools_has_Skill` = frontmatter `allowed-tools` contains `Skill`.
- `axis2_today` = `model-invokable` for every row (ADR-018: 0 disable flags).
- Tokens column **omitted**. `plugins/compress/scripts/count_tokens.py count` was not executed here (this pass has no shell; the script prefers `ANTHROPIC_API_KEY` / network and otherwise needs tiktoken or falls to estimate). Char count is the mandatory metric.

**Hard constraint (ADR-018):** a parent cannot `Skill()` a child with `disable-model-invocation: true`. Do **not** flag `/dev` or `/ship`.

## Inventory

| skill | desc_chars | has_disable_model_invocation | trigger_phrases | pipeline_class | invoked_by_factory | allowed_tools_has_Skill | collision_notes | axis2_today | axis2_later_candidate |
|---|---:|---|---|---|---|---|---|---|---|
| adr | 135 | false | "create an ADR" \| "architecture decision" \| "document why we chose" \| "list ADRs" | standalone (inferred) | no | no | "architecture decision" vs clarify architecture language | model-invokable | unknown |
| adversarial | 333 | false | "adversarial" \| "red team" \| "devil's advocate" \| "attack this design" \| "kill this idea" \| "stress test this" \| "what breaks this" \| "adversarial review" | standalone | no | no | "adversarial review" vs code-review / advisory review | model-invokable | keep-model |
| advisory | 316 | false | "advisory" \| "second opinion" \| "advise on this" \| "strengthen this" \| "expert advice" \| "advisory review" \| "what would you improve" | standalone | no | no | "advisory review" vs adversarial / code-review | model-invokable | keep-model |
| analyze | 284 | false | "analyze" \| "technical analysis" \| "explore the problem" \| "how deep is it" \| "deep dive" \| "investigate this" \| "analyze this feature" \| "what are the risks" \| "explore the codebase" \| "look into this" | adv + approval-stop | yes | yes | "explore the *" vs interview "explore ideas"; "write analysis" lives on interview | model-invokable | keep-model |
| checkup | 217 | false | "checkup" \| "health check" \| "check setup" \| "verify config" \| "security baseline" | standalone (inferred) | no | no | "check setup" / "verify config" vs validate "check everything" | model-invokable | unknown |
| ci-setup | 196 | false | "ci setup" \| "setup ci" \| "configure ci" \| "setup hooks" \| "setup github actions" | standalone (inferred) | no | no | "setup hooks" vs release-setup hook language (body, not trigger) | model-invokable | keep-model |
| ci-watch | 224 | false | "watch ci" \| "ci watch" \| "watch the ci" \| "watch run" \| "monitor ci" | adv | yes | no | — | model-invokable | keep-model |
| clarify | 507 | false | "clarify intent" \| "explain the architecture" \| "restate what we are solving" \| "recap the issue" \| "restructure the answer" \| "intent first" \| "explain it properly" \| "what is the architecture" \| "explain from intent down" \| "step back and explain" | view (inferred) | no | yes | longest desc; architecture phrasing vs adr; "what are we solving" lives on frame | model-invokable | unknown |
| cleanup | 205 | false | "cleanup" \| "clean branches" \| "cleanup worktrees" \| "remove stale branches" | adv | yes | no | "cleanup" vs cleanup-context "cleanup context" | model-invokable | keep-model |
| cleanup-context | 307 | false | "cleanup context" \| "context audit" \| "clean memory" \| "drain memory" \| "prune memory" \| "audit memory" \| "consolidate rules" \| "spa day" \| "memory audit" | standalone (inferred; `/dev --cleanup-context`) | yes | no | "cleanup context" vs cleanup | model-invokable | keep-model |
| code-review | 260 | false | "code review" \| "review changes" \| "review PR #42" \| "check my code" \| "review my changes" \| "review this PR" \| "do a code review" \| "review the diff" \| "look at my code" | verdict | yes | yes | generic "review *" vs adversarial/advisory review | model-invokable | keep-model |
| dev | 206 | false | "dev" \| "start working on" \| "work on issue" \| "work on #" \| "develop" \| "pick up issue" \| "tackle issue" \| "let's work on" | factory (inferred) | no (is the factory) | yes | NL factory path — must stay model-invokable | model-invokable | keep-model |
| doc-sync | 222 | false | "sync docs" \| "update docs" \| "doc sync" \| "sync plugin docs" \| "update skill docs" \| "update the docs" | standalone (inferred) | no | no | "update docs" vs readme-upgrade "upgrade docs" / "improve docs" | model-invokable | unknown |
| env-setup | 223 | false | "env setup" \| "setup environment" \| "configure stack" \| "scaffold rules" | standalone (inferred) | no | no | **exact** "configure stack" vs stack-setup | model-invokable | keep-model |
| fix | 275 | false | "fix findings" \| "fix review" \| "apply fixes" \| "fix these" \| "apply review comments" \| "apply the review" \| "fix the review issues" \| "address review feedback" \| "fix PR comments" | loop | yes | yes | — | model-invokable | keep-model |
| frame | 264 | false | "frame" \| "frame this" \| "what's the problem" \| "define the problem" \| "scope this out" \| "define the scope" \| "what are we solving" \| "help me think through this problem" \| "problem statement" | adv + approval-stop | yes | yes | "think through this problem" vs interview; "what are we solving" vs clarify | model-invokable | keep-model |
| implement | 220 | false | "implement" \| "build this" \| "execute plan" \| "start coding" \| "write the code" \| "code this up" \| "let's build it" \| "build it out" \| "ship it" | adv | yes | yes | **"ship it" vs /ship**; "build this" vs spec "what will we build" | model-invokable | keep-model |
| interview | 278 | false | "create a spec" \| "interview" \| "brainstorm" \| "write analysis" \| "promote to spec" \| "let's brainstorm" \| "think through this" \| "help me brainstorm" \| "let's think this through" \| "explore ideas" | standalone (inferred) | no | no | **"create a spec" vs /spec**; "write analysis" vs /analyze; "promote to spec" vs /promote; "think through" vs /frame | model-invokable | keep-model |
| plan | 271 | false | "plan" \| "plan this" \| "implementation plan" \| "break it down" \| "plan this feature" \| "how should we build this" \| "make a plan" \| "create a plan" \| "break this down into tasks" \| "task breakdown" | adv + approval-stop | yes | yes | — | model-invokable | keep-model |
| pr | 281 | false | "create PR" \| "open PR" \| "submit PR" \| "update PR" \| "/pr --draft" \| "open a pull request" \| "make a PR" \| "open pull request" \| "submit a pull request" \| "create a draft PR" \| "raise a PR" | adv | yes | no | — | model-invokable | keep-model |
| promote | 256 | false | "promote staging" \| "release" \| "deploy" \| "cut a release" \| "--finalize" \| "merge to main" \| "promote to production" \| "ship a release" \| "tag and release" \| "publish release" | standalone | no | no | **"release"/"deploy"/"ship a release"** vs /ship + release-setup; "promote to spec" lives on interview | model-invokable | side-effect-gate-candidate |
| readme-upgrade | 359 | false | "improve readme" \| "upgrade docs" \| "readme quality" \| "improve docs" \| "doc audit" \| "readme upgrade" \| "improve contributing" \| "docs health" | standalone (inferred) | no | no | **"upgrade docs"** exact vs doc-sync family; "improve contributing" vs seed-community | model-invokable | unknown |
| recheck | 210 | false | "recheck" \| "is this issue still valid" \| "check drift" \| "check issue staleness" | adv | yes | yes | — | model-invokable | keep-model |
| release-setup | 218 | false | "release setup" \| "setup releases" \| "commit standards" \| "setup release automation" | standalone (inferred) | no | no | "release setup" vs promote "release" | model-invokable | keep-model |
| seed-community | 421 | false | "seed community" \| "bootstrap community files" \| "add contributing" \| "add license" \| "add security policy" \| "github community files" | standalone (inferred) | no | no | "add contributing" vs readme-upgrade; "bootstrap *" vs seed-docs | model-invokable | side-effect-gate-candidate |
| seed-docs | 277 | false | "seed docs" \| "bootstrap docs" \| "populate docs" \| "fill architecture docs" \| "seed architecture" | standalone (inferred) | no | no | "bootstrap docs" vs seed-community / setup-worktree "bootstrap branch" | model-invokable | side-effect-gate-candidate |
| setup-worktree | 154 | false | "setup worktree" \| "create worktree" \| "prepare workspace" \| "bootstrap branch" | adv (inferred; `/dev`/`/implement` bootstrap, ¬STEPS) | yes | no | "bootstrap branch" vs seed-* bootstrap | model-invokable | keep-model |
| ship | 238 | false | "ship" \| "ship this" \| "land this" \| "land the PR" \| "ship PR" \| "submit for merge" \| "get this merged" \| "ship my branch" | meta-orchestrator | no (is the factory) | yes | **"ship" vs implement "ship it"**; merge language vs promote "merge to main" | model-invokable | keep-model |
| spec | 251 | false | "write spec" \| "spec this" \| "solution design" \| "what will we build" \| "design the solution" \| "acceptance criteria" \| "define acceptance criteria" \| "spec it out" \| "write the spec" | adv + approval-stop | yes | yes | **"write spec" vs interview "create a spec"** | model-invokable | keep-model |
| stack-setup | 309 | false | "stack setup" \| "setup stack" \| "configure stack" \| "fill stack.yml" \| "stack wizard" \| "stack-setup" | standalone (inferred) | no | no | **exact "configure stack" vs env-setup** | model-invokable | unknown |
| test | 255 | false | "test this file" \| "write tests" \| "add coverage" \| "run tests" \| "e2e tests" \| "add tests" \| "test coverage" \| "generate tests" \| "test this" \| "write unit tests" \| "add integration tests" | standalone (inferred) | no | no | "run tests" adjacent to validate (QG includes test); `/implement` does **not** `Skill()` `/test` | model-invokable | unknown |
| validate | 205 | false | "validate" \| "check everything" \| "quality check" \| "pre-push check" \| "are we green" | adv | yes | no | "check everything" vs checkup | model-invokable | keep-model |

### Totals

| metric | n |
|---|---:|
| skills (SKILL.md) | **32** |
| sum desc_chars | **8377** |
| with Triggers list | **32** |
| `disable-model-invocation: true` | **0** |
| factory-invoked (`/dev` or `/ship` `Skill()`s) | **14** |
| `allowed-tools` contains Skill | **11** |
| keep-model | **22** |
| side-effect-gate-candidate | **3** |
| unknown | **7** |

No skill is missing a `description`.

## Skill() graph (measured)

**`/dev` factory** (`skills/dev/SKILL.md` Step 7 + bootstrap + Step 0):

| callee | how |
|---|---|
| recheck, frame, analyze, spec, plan, implement, pr, ci-watch, validate, code-review, fix, cleanup | Step 7 invocation map |
| setup-worktree | silent bootstrap when `S* ∈ {frame, analyze, spec, plan, implement}` |
| cleanup-context | `--cleanup-context` → `skill: "cleanup-context"` then stop |
| promote | listed as `skill: "promote"` but **never auto-triggered** (Step 4 `promote → skip`) |

**`/ship` factory** (`skills/ship/SKILL.md` steps): `pr`, `code-review`, `fix`, `ci-watch`, `cleanup`.

**Other skills `Skill()` a peer:**

| caller | callee | note |
|---|---|---|
| frame, analyze, plan | adversarial, advisory | React tables |
| analyze | interview | `Ω := skill: "interview"` + Step 2b `Ω, args: …` |
| implement | setup-worktree | missing ω |
| recheck | `issue-triage` (roxabi-issues) | external; not in this table |
| clarify | `forge-chart` | not a dev-core skill |
| spec | — | **¬** invoke `/interview`; adversarial is a **subagent**, not `Skill()` |
| `/dev-init` (dev-init plugin) | `dev-core:env-setup`, `dev-core:ci-setup`, `dev-core:release-setup` | other-plugin Skill(); next-step prose only for checkup / seed-docs |

`/test` SKILL.md mentions “when invoked by `/implement`” but `/implement` never `Skill()`s `/test` (inline tester agent + QG).

## Analysis

### Always-on description tax

All 32 descriptions are in the host skill menu today (`axis2_today = model-invokable`). **8377 characters** of always-on description text.

Distribution (chars): clarify 507, seed-community 421, readme-upgrade 359, adversarial 333, advisory 316, stack-setup 309, cleanup-context 307 — seven skills ≥300 chars carry 2512 / 8377 (30%). Shortest: adr 135, setup-worktree 154, ci-setup 196.

Triggers are the bulk of several mid-length rows (pr 11 phrases, test 11, interview / plan / analyze / spec 9–10). That is menu-routing cost, not body-instruction cost.

### Trigger collisions

| overlap | skills | phrases |
|---|---|---|
| **exact duplicate** | env-setup, stack-setup | `"configure stack"` |
| ship verb | implement, ship, promote | implement `"ship it"` · ship `"ship"` / `"ship this"` / `"ship PR"` · promote `"ship a release"` |
| spec creation | interview, spec | interview `"create a spec"` · spec `"write spec"` / `"write the spec"` / `"spec this"` |
| release / deploy | promote, release-setup, ship | promote `"release"` / `"deploy"` / `"cut a release"` / `"merge to main"` · release-setup `"release setup"` · ship `"submit for merge"` / `"get this merged"` |
| docs upgrade | doc-sync, readme-upgrade | `"update docs"` / `"update the docs"` vs `"upgrade docs"` / `"improve docs"` |
| cleanup noun | cleanup, cleanup-context | `"cleanup"` vs `"cleanup context"` |
| think / explore / analysis | interview, frame, analyze | `"think through this"` · `"help me think through this problem"` · `"explore ideas"` / `"explore the problem"` · `"write analysis"` |
| promote verb | interview, promote | `"promote to spec"` vs `"promote staging"` / `"promote to production"` |
| contributing | seed-community, readme-upgrade | `"add contributing"` vs `"improve contributing"` |
| check / health | validate, checkup | `"check everything"` vs `"check setup"` / `"health check"` |

**Top collisions (routing risk):** (1) `"configure stack"` exact pair, (2) `"ship it"` vs `/ship`, (3) `"create a spec"` vs `/spec`, (4) promote `"release"`/`"deploy"` vs `/ship` + `/release-setup`, (5) `"upgrade docs"` / `"update docs"` pair.

### Must stay model-invokable

Parent cannot `Skill()` a `disable-model-invocation` child. This set must stay `keep-model`:

**Factories (never flag):** `/dev`, `/ship`.

**`/dev` / `/ship` callees (14):** recheck, frame, analyze, spec, plan, implement, pr, ci-watch, validate, code-review, fix, cleanup, setup-worktree, cleanup-context.

**Peer-`Skill()` reachability:** adversarial, advisory (frame / analyze / plan React); interview (analyze `Ω`).

**Other-plugin `Skill()`:** env-setup, ci-setup, release-setup (`/dev-init`). Flagging these would break init composition the same way it would break `/dev`.

`cleanup` is **not** a side-effect-gate-candidate: both factories `Skill()` it (`/dev` Step 7 `args: "--scope #N"`; `/ship` Step 8). Verified against the user hedge (“cleanup only if nothing Skill()s it”).

### Side-effect-gate candidates (later, not a context win)

`disable-model-invocation` is a **side-effect gate** (ADR-018), not a menu-token lever. Only standalone mutators with **no** `Skill()` caller:

| skill | why candidate | why not today |
|---|---|---|
| promote | staging→main / tag / release; `/dev` never invokes | human NL `/promote` still works if flagged |
| seed-docs | writes architecture/standards docs; `/dev-init` only *mentions* it | same |
| seed-community | writes LICENSE / CoC / templates; no Skill() caller | same |

**3** candidates. Do not treat this as a context-load win — descriptions stay in the menu until flagged, and flagging only blocks model self-fire.

**unknown (7), not flagged as candidates:** adr, checkup, clarify, doc-sync, readme-upgrade, stack-setup, test. Standalone; some mutate disk; none are Skill()-reachable from `/dev`/`/ship`. Left unknown because they are not in the ADR-018 example set (`promote`, `seed-*`, `cleanup`) and several are NL onboarding / view surfaces.

### Out of scope for axis 2

- Do not set `disable-model-invocation` on `/dev` or `/ship`.
- Do not use the flag to shrink the 8377-char description tax on factory-reachable skills.
- Axis 1 `standalone` ≠ humans-only (adversarial / advisory stay Skill()-reachable).

## Trigger hygiene (2026-08-18)

Axis 2 collision cleanup — thief drops the phrase; winner keeps it. Descriptions only (`disable-model-invocation` not set; `/dev`/`/ship` untouched).

| phrase dropped | from (thief) | winner |
|---|---|---|
| `"configure stack"` | env-setup | stack-setup |
| `"ship it"` | implement | ship |
| `"create a spec"` | interview | spec |
| `"write analysis"` | interview | analyze |
| `"promote to spec"` | interview | promote |
| `"release"` (bare) | promote | ship / release-setup |
| `"deploy"` | promote | ship |
| `"merge to main"` | promote | ship |
| `"ship a release"` | promote | ship |
| `"update docs"` | doc-sync | (docs family — kept on neither; readme-upgrade keeps readme-specific) |
| `"update the docs"` | doc-sync | (same) |
| `"upgrade docs"` | readme-upgrade | (docs family — doc-sync keeps sync-family) |
| `"improve docs"` | readme-upgrade | (same) |

## Trigger hygiene pass 2 (2026-08-18)

Residual collisions after 18ab44e. Same rule: thief drops the phrase; winner keeps it. Descriptions + README Triggers only (`disable-model-invocation` not set; `/dev`/`/ship` untouched).

| phrase dropped | from (thief) | winner |
|---|---|---|
| `"help me think through this problem"` | frame | interview (`"think through this"` / `"explore ideas"`) |
| `"explore the problem"` | analyze | interview (`"explore ideas"`); frame keeps problem/scope language |
| `"check everything"` | validate | checkup (`"check setup"`) |
