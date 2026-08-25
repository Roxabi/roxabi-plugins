---
title: "ADR-018: Skill-system homes and composition"
description: "One home per fact in the dev-core skill system: three orthogonal axes, placement law, refuse list. /dev stays NL-routable."
---

## Status

Accepted — 2026-08-17 (human confirmed the cadastre).

## Context

dev-core is a **factory**: TypeScript, hooks, CLI, doctor, and worktrees under `plugins/dev-core/`, plus 32 `SKILL.md` files that the host autoloads from `skills/` (`plugins/dev-core/.claude-plugin/plugin.json` has no `skills` allowlist). `/dev` and `/ship` stay model-invokable so natural language ("start working on #42") still launches the factory. Measured 2026-08-17: **0** of those 32 files set `disable-model-invocation`.

The skill system already has three libraries of fact:

1. `plugins/shared/references/notation.md` — marketplace glyphs + Reserved-Variable Registry.
2. `plugins/dev-core/skills/shared/references/chain-contract.md` — author-facing pipeline contract. Header: **not loaded at runtime**.
3. A `Let:` block in every skill (32 `SKILL.md` files; 34 `Let:` lines because `stack-setup` and `env-setup` each have a second block) that re-binds words the registry already names.

The failure mode is **N homes for one fact**, not a missing fourth library. `τ` is defined in `notation.md`, `tier-classification.md`, `dev-process.md`, and dozens of `Let:` lines. `σ` is a four-way collision in the registry (`.claude/stack.yml` · spec artifact · status-icon map · staging branch). Approval-stop, done-signal, principal, factory, and Issue are English process words that glyphs cannot hold, so they get copied into skill bodies.

Three questions are being answered by one informal mix:

- How does a skill participate in `/dev` / `/ship`? (ADR-010 / `chain-contract.md` already answers this.)
- Who is allowed to fire it? (unanswered — every skill is model-invokable.)
- How does another author or skill reach a fact? (`Skill()`, `Read` of a format doc, named prose, inline copy, or `bun`/`bash` — all five are in use.)

A first draft (Vague 0) proposed a `CONTEXT.md` plus `disable-model-invocation` on `/dev` and `/ship`. That would buy roughly a hundred tokens and would break installer natural-language routing. ADR-004 already rejected a standalone `/audit` skill (Option D). ADR-013 already chose named prose `write_candidate` over extracting `/falsify`. Re-compressing 400-line `SKILL.md` files is not the main lever.

ADR-010 remains in force for the **pipeline** axis: `/dev` owns the dev-pipeline task lifecycle; skill classes (`adv`, `adv + approval-stop`, `verdict`, `loop`, `standalone`) stay. **Redundancy-with-locality** (each child inlines Chain Position / Task Integration / Exit because `chain-contract.md` is not runtime-included) is the **current mitigation**, not the target end-state. Retiring those inlines happens only after `/dev` is a reliable sole chain owner — not in this ADR's landing.

## Options Considered

### Option A: CONTEXT.md + hide `/dev` / `/ship`

Add a fourth library (`CONTEXT.md`) and set `disable-model-invocation: true` on the two factories so they drop out of the model's skill list.

- **Pros:** Slightly smaller default skill menu; one new file to point at.
- **Cons:** Installer regression — "start working on #42" no longer routes to `/dev`. A parent cannot `Skill()` a child that has `disable-model-invocation: true` (Claude host docs; Grok is not assumed to honor the flag). Fourth glossary restates `notation.md` + `chain-contract.md` + the `Let:` corpus. Token win is ~100.

### Option B: Placement law + three axes, no fourth glossary, `/dev` stays NL (chosen)

Keep `/dev` and `/ship` model-invokable. Do not add `CONTEXT.md`. Lock glyphs in `notation.md`. Give English process words one thin home. Classify every fact by kind and give that kind one home. Record an extraction **gate** for turning a procedure into a callable skill; do not pre-commit "every procedure becomes a `Skill()`".

- **Pros:** One test for authors. NL factory path preserved. Orthogonal to ADR-010. Vague 1 extracts become possible without a false mandate.
- **Cons:** Notation lock will force collision resolution later. Child Exit blocks stay until `/dev` is the sole chain owner.

### Option C: Become a Matt-style markdown-only skill kit / router

Replace the TS / hooks / CLI / doctor / worktree factory with a markdown router that only `Skill()`s children.

- **Pros:** Smaller runtime surface; closer to a pure skill pack.
- **Cons:** Refuse list. We are a factory. Doctor, worktree, scan-state, hooks, and copy-sync (ADR-014) are the product, not a temporary scaffold.

### Option D: Keep redundancy-with-locality forever as the architecture

Treat the ADR-010 inline Chain Position / Exit copies as the permanent SSoT. Keep `chain-contract.md` as a second runtime-shaped source. Keep `Let:` redefinitions of canonical words.

- **Pros:** Matches today's failure-mode mitigation (model asks "proceed to /X?" when chain context is only in `/dev`).
- **Cons:** N homes stay the architecture. Drift between 13+ Exit blocks and `/dev` Step 7/8 is permanent. Rejected as **target**. Remains the **current mitigation** until `/dev` is the sole chain owner.

## Decision

Adopt **Option B**.

### Three orthogonal axes

| Axis | What it answers | Exists today? |
|---|---|---|
| (1) Pipeline class | How the skill participates in `/dev` / `/ship` | Yes — ADR-010 / `chain-contract.md`. Classes: `adv`, `adv + approval-stop`, `verdict`, `loop`, `standalone`. |
| (2) Invocation budget | Who can fire it: human NL/slash vs model vs other `Skill()` | No — all 32 skills are model-invokable; 0 have `disable-model-invocation`. |
| (3) Composition | How others reach a fact: `Skill()` vs `Read` format vs named prose vs inline vs `bun`/`bash` | Informal — mix of all five. |

Axis 1 `standalone` means **never auto-triggered by `/dev`**. It does **not** mean "humans only." Today that class mixes two axis-2 budgets:

- Human types it (`/promote`, `/cleanup` as a side-effect, `seed-*`).
- Other skills may `Skill()` it (`/adversarial`, `/advisory` — invoked from `/frame`, `/analyze`, `/plan` React tables).

Split those on axis 2. Do not invent a new pipeline class for "Skill()-reachable standalone."

**Hard constraint on axis 2.** A parent **cannot** `Skill()` a child that has `disable-model-invocation: true` (Claude host / Anthropic). Therefore every skill that `/dev` or `/ship` invokes via `Skill()` **must** stay model-invokable. That set today includes at least `recheck`, `frame`, `analyze`, `spec`, `plan`, `implement`, `pr`, `ci-watch`, `validate`, `code-review`, `fix`, `cleanup`, `setup-worktree`, plus `/ship`'s `pr` / `code-review` / `fix` / `ci-watch` / `cleanup`. `disable-model-invocation` is Claude-only; do not assume Grok honors it. Treat the flag as a **side-effect gate** for later standalone side-effect skills (`promote`, `cleanup`, `seed-*`) — never as a context-load win on the factories. **Do not set it on `/dev` or `/ship`.**

### Placement law (cadastre)

One home per fact. If the fact already has a home, point or invoke — never recopy.

| Kind of fact | Examples | One home | Others reach by | Forbidden |
|---|---|---|---|---|
| Word | Issue, approval-stop, principal, `τ` = tier only | Glyphs: `plugins/shared/references/notation.md` (bindings **locked** — one sense; `(local)` is no longer the desired steady state). English process words glyphs cannot hold: one thin section in that same file (`## English process words`) — not a sibling glossary, not `CONTEXT.md`. | Authors write with it; `/dev` may `Read` once. | 30+ `Let:` redefinitions of canonical words; a fourth glossary that restates `τ` / `σ` / `φ`. |
| Format | frontmatter `status:`, done-signal keys, plan-task schema | One format doc under `plugins/dev-core/skills/shared/references/` (`artifact-frontmatter.md`, `plan-task-schema.md`). `tier-classification.md` is the S / F-lite / F-full SSoT (criteria, signals, scoring). | `Read` when writing that artifact. | Recopying keys into every `SKILL.md`. |
| Procedure | approval-stop, falsification, interview, TDD | Prefer one model-invoked skill **only if** the extraction gate passes; else named prose in one file (ADR-013 `write_candidate` style). | `Skill("X")` or named-prose pointer. | Inline the same algorithm in 2+ `SKILL.md`. |
| Orchestration | who runs next, task lifecycle | `/dev` (feature path) and `/ship` (land path) only. | Human NL or slash; factory `Skill()`s children. | Child Chain Position / Exit as the long-term SSoT; `chain-contract.md` as a second *runtime* source. |
| Mechanism | worktree, scan-state, doctor, hooks | Code (TS / sh / hook) under `skills/shared/`, `hooks/`, `cli/`, `tools/`, or the owning skill's scripts. Copy-sync unchanged (ADR-014). | `bash` / `bun` / `Skill("setup-worktree")`. | Narrating the algorithm in `SKILL.md`. |

**Extraction gate** (axis 3, procedures). Extraction to a callable skill is **allowed later**, not mandated. The gate holds when at least one of these is true:

- two algorithms (callers need a named choice, not a copy);
- a disk contract (writers would otherwise recopy keys — that is a Format, `Read` it; if the procedure *enforces* the contract across skills, it may become a skill);
- a turn-stop (the procedure must own the HITL turn, the way approval-stop skills do).

ADR-013 named prose and ADR-004's rejection of `/audit` remain the default when the gate fails.

### Folder assignment

| Path | Role |
|---|---|
| `plugins/shared/references/` | Marketplace language. `notation.md` is locked (glyphs + thin English process words). |
| `plugins/dev-core/skills/shared/references/` | **Formats only** (target). Today this directory also holds author-facing and protocol files; those are cadastre follow-up, not this landing. Keep `artifact-frontmatter.md`, `plan-task-schema.md`, `tier-classification.md`, host contracts (`harness-*.md`), and format templates (`reasoning-audit.md`, `release-convention.md`). |
| `plugins/dev-core/skills/shared/` TS | Mechanisms + copy-sync (ADR-014). Unchanged. |
| `plugins/dev-core/references/` | Human contributor docs. Must stop being a second SSoT. Today `dev-process.md` **and** `tier-classification.md` both define S / F-lite / F-full — `tier-classification.md` wins. `dev-process.md` keeps phases / artifacts / git overview and points at the tier file. |
| `skills/<name>/SKILL.md` | Either a factory (`/dev`, `/ship`) or a procedure. No canonical `Let:` of shared words. No long-term Chain Position copy. |
| `agents/` | Roles. `base.md` is the only shared agent protocol (`engineer.md` is the implementation-agent companion). |
| `hooks/` `cli/` `tools/` | Host / CI mechanisms. |
| `plugin.json` | Shipped set (allowlist is the **target**; autodiscovery of all `skills/` is the current state). This ADR does not edit `plugin.json`. |

`chain-contract.md` becomes an **author-facing view** of `/dev` (or is retired). It is not a runtime include. This ADR does not edit that file.

### Refuse list

- Keep the TS / hooks / CLI / doctor / worktree factory.
- Do not replace `/dev` with a Matt-style markdown-only router.
- Do not treat re-compress of 400-line `SKILL.md` as the main lever.
- Do not add `CONTEXT.md`.
- Do not set `disable-model-invocation` on `/dev` or `/ship`.
- Do not pre-commit "every procedure becomes a `Skill()`."

### Relation to ADR-010

Pipeline class, `/dev`-owns-lifecycle, and the five skill classes stay. Redundancy-with-locality stays as the **current** mitigation for the "proceed to /X?" failure mode. This ADR is orthogonal on axes 2 and 3. Retiring child Exit / Chain Position inlines is **out of landing** — it waits on `/dev` being a reliable sole chain owner.

## Consequences

### Positive

- One author test: does this fact already have a home? Then point or invoke, never recopy.
- Vague 1 extracts become possible without a false `Skill()` mandate; the extraction gate is the check.
- Installer natural-language path is preserved (`/dev` and `/ship` stay model-invokable).
- Axis 1 `standalone` is no longer overloaded with "humans only" — `Skill()`-reachable advisory skills stay legal.

### Negative

- Notation lock will force collision resolution. `σ` is four-way today (stack.yml · spec artifact · status-icon map · staging branch); `α`, `β`, `ω`, `μ`, `τ`, `φ`, `π`, `Σ`, `Ω` are also marked collision in the 2026-07-04 registry. This ADR names them; it does not pick winners.
- Retiring child Exit blocks is deferred and will feel like a risk versus ADR-010's original failure mode (model asks "proceed to /X?").

### Neutral

- No `SKILL.md` edits in the landing of this ADR. No `CONTEXT.md`. No `disable-model-invocation` flip. No `plugin.json` allowlist edit.
- First follow-up is **cadastre**, not primitive extraction: lock `notation.md` bindings; add the thin English process-words section; make `tier-classification.md` the only tier SSoT (`dev-process.md` points, does not redefine); inventory skill `description` fields against axis 2.
- `chain-contract.md` stays on disk as an author-facing view until a later change retires or folds it into `/dev`.

## Amendment (2026-08-24)

Axis 2 is no longer "all model-invokable." Ten **standalone** skills are **user-invoked** (slash-only): `adr`, `stack-setup`, `promote`, `seed-docs`, `seed-community`, `doc-sync`, `readme-upgrade`, `test`, `dev-checkup`, `dev-init`. Each sets `disable-model-invocation: true` and drops the `Triggers:` list from `description` (human one-liner only).

**Unchanged on axis 2:** `/dev`, `/ship`, and every skill that a factory or parent invokes via `Skill()` stay **model-invokable**. Do **not** set the flag on those.

**Portable field:** `disable-model-invocation` is the Claude + OMP invocation gate. It is not `hide`, not a `commands/` shim.

**OMP back-half:** After spec validation, the build pipeline (plan → implement → review → merge) lives in sibling plugin `omp-build`, not as a rewrite of `/dev`. The refuse list still blocks replacing `/dev` with a markdown-only router on Claude/Grok.

**CONTEXT.md:** The refuse list still forbids a fourth glossary **inside dev-core**. Product/kit `CONTEXT.md` files (`docs/kit/`, `docs/product/`) are out of scope for this ADR.
