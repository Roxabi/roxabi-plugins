---
name: analyze
argument-hint: '[--issue <N> | --frame <path>]'
description: Deep technical analysis — explore existing code, risks, alternatives. Triggers: "analyze" | "technical analysis" | "explore the problem" | "how deep is it" | "deep dive" | "investigate this" | "analyze this feature" | "what are the risks" | "explore the codebase" | "look into this".
version: 0.4.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Task, Skill, ToolSearch
---

# Analyze

## Success

I := α written ∧ executive summary shown ∧ shapes ∃ ∧ (approved → committed)
V := `ls artifacts/analyses/{N}-*.md*` ∧ (on approve) `git log --oneline -1 | grep analysis`

Let:
  α := artifacts/analyses/{N}-{slug}-analysis.md
  φ := artifacts/frames/{slug}-frame.md
  ρ := expert reviewer set
  Ω := `skill: "interview"`
  χ := open unknown (unresolved question blocking shape choice)

Frame → codebase exploration → expert review → **executive summary in chat** → free-form human reaction.
¬spec, ¬worktree. Shape phase only. Spec → `/spec`.

## Hard ban — AskUserQuestion

**Never call AskUserQuestion / `present choice` / multi-select tool prompts in this skill.**

Human-in-the-loop is **chat-native** (same doctrine as `/spec`):
1. Do the exploration.
2. Print a clear **Executive Summary**.
3. **Stop this turn** and wait for the user's free-form reply.
4. Interpret natural language (approve / prefer shape 2 / question / spike X / re-analyze) and act.

No button menus. No forced option lists. Missing information → write it into the summary as χ — do not quiz via AQ.

Exception: the structured `/interview` in Step 2b keeps its own question flow (it is the elicitation engine, not a gate).

## Entry

```
/analyze --issue N    → read frame for #N, produce α
/analyze --frame path → read frame at path, produce α
```

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 0 | resolve | ✓ | φ ∃ | — |
| 1 | scan | — | α ∃? | — |
| 2 | explore | ✓ | α written | Glob+Grep+interview |
| 2.5 | investigate | — | hypothesis resolved | optional spike; ¬AQ |
| 3 | review | — | agents return | ∥ spawn; auto-select ρ |
| 4 | summary | ✓ | exec summary shown | **stop turn** — wait for chat |
| 5 | react | ✓ | free-form | approve → commit; else revise loop |

## Pre-flight

Success: α written ∧ exec summary shown ∧ (approved → committed)
Evidence: `git log --oneline -1 | grep analysis`
Steps: resolve → scan → explore → review → summary → react
¬clear → STOP + ask: "Is this technical analysis or framing?"

## Step 0 — Resolve Input

Parse args → locate φ.

`--issue N`:
```bash
# Find frame by issue number in frontmatter or filename
grep -rl "issue: N" artifacts/frames/ 2>/dev/null | head -1
# Fallback: glob by any slug
ls artifacts/frames/*.md* 2>/dev/null
```

`--frame path` → read directly.
¬φ found → ask user "No frame doc found. Run `/frame --issue N` first, or provide path directly?"

Read φ → extract: `title`, `issue`, `tier`, **problem statement**, outcome, constraints.
- Problem (φ) → α `## Problem` + exec summary **Solve**
- Outcome (φ) → α `## Outcome` + exec summary **Done when**
- Problem empty/sparse → derive from title + constraints (1–2 lines), or list as χ — ¬invent a problem φ never stated

## Step 1 — Scan Existing Analysis

Glob `artifacts/analyses/*` — match issue# or slug from φ.

| State | Action |
|-------|--------|
| ∃ α ∧ `type: brainstorm` ∈ frontmatter | ¬analysis — say so in one line, use as seed → Step 2 (promote via interview) |
| ∃ α (analysis) | **Reuse.** Print short note + **lean Executive Summary** (Step 4 structure + hard caps) of existing α → Step 4/5 (chat: approve to keep & continue pipeline, or "re-analyze" / changes). ¬regenerate unless user asks. |
| ¬∃ α | Step 2 explore fresh |

## Step 2 — Codebase Exploration + Interview

### 2a. Glob + Grep

Search codebase based on φ problem + constraints:

```bash
# Find files relevant to the domain (adapt to actual problem):
Glob("{backend.path}/src/**/*.ts")    # backend domain
Glob("{frontend.path}/src/**/*.tsx")  # frontend domain
Grep("keyword", type: "ts")           # symbol/pattern search
```

Read key files (max 5–8 most relevant). Note: paths, patterns, dependencies, risks.

### 2b. Interview

`Ω, args: "topic text from frame"` (Analysis type).

Captures: source (verbatim trigger) | problem (broken/missing) | outcome (success ¬prescribing solution) | appetite (time budget) | shapes (2–3 mutually exclusive arch approaches: name + trade-offs + scope) | constraint alignment (which constraints eliminate which shapes).

Pre-fill context from φ — skip answered questions.

## Step 2c — Generate Analysis

F-lite/F-full: generate forge-chart sidecars per [forge-chart-sidecar.md](${CLAUDE_PLUGIN_ROOT}/references/forge-chart-sidecar.md) **before** writing α.

Write α:

```md
---
title: "{title}"
description: "{one-line description}"
---

## Source

{verbatim trigger — exact quote, ticket, Slack message}

## Problem

{what is broken or missing today, in plain language}

## Outcome

{what success looks like — without prescribing a solution}

## Appetite

{time budget — e.g. "1-week cycle", "2 sprints"}

## Shapes

**Diagram:** [{shapes title}](../visuals/{N}-{slug}-shapes.html)

### Shape 1: {name}

{description}

**Trade-offs:**
- Pro: ...
- Con: ...

**Rough scope:** {XS | S | M | L | XL}

### Shape 2: {name}

...

## Fit Check

**Diagram:** [{data flow title}](../visuals/{N}-{slug}-data-flow.html)

{Which shape best fits constraints + appetite, and why. Which shapes are eliminated.}
```

### Forge-Chart Sidecars (F-lite/F-full)

Read [forge-chart-sidecar.md](${CLAUDE_PLUGIN_ROOT}/references/forge-chart-sidecar.md) before generating visuals.

When analysis involves data flow or architectural choices, generate forge-chart sidecars (¬inline mermaid, ¬ASCII):
- **`## Shapes`** (≥2 shapes) → `{N}-{slug}-shapes.html` — architecture diagram with zones per shape
- **`## Fit Check`** (data flow or arch choice) → `{N}-{slug}-data-flow.html` — recommended shape topology

Link in α:

```markdown
**Diagram:** [{title}](../visuals/{N}-{slug}-{kind}.html)
```

**Files impacted** table: always include when ≥3 files touched.

Tier S may omit Shapes + Fit Check sidecars.

∃ specific technical question → spawn domain expert via Task. See [references/expert-consultation.md](${CLAUDE_SKILL_DIR}/references/expert-consultation.md).

## Step 2.5 — Investigation (Optional)

Skip if ¬technical uncertainty in Step 2 findings.

**Signals:** unfamiliar 3rd-party behavior | undocumented internal APIs | performance unknowns | conflicting docs.

∃ signals → **¬AQ**. Decide:
- unknown blocks shape selection (cannot rank shapes without it) → run the spike now, one prose line saying why
- else → continue to Step 3; carry the unknown as χ into the Executive Summary. User can request it later with `spike …` (Step 5).

**Spike flow** (principal stays on β — [harness-worktree.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/harness-worktree.md)):

1. Create throwaway ω on branch `spike-{N}` **without** switching principal:
   - H_wt claude-enter: `EnterWorktree(name: "spike-{N}")` if supported, else `git worktree add` under `.claude/worktrees/spike-{N}`
   - H_wt harness-default: `git worktree add "$(suggested_grok_worktree_path "" "spike-${N}")" -b "spike-${N}"` (or from β)
2. Investigate **inside ω only**: minimal code, isolated test, confirm/reject hypothesis
3. Report findings → incorporate into α
4. Teardown: `ExitWorktree(action: "remove", discard_changes: true)` **or** `git worktree remove --force "$SPIKE_PATH"` + `git branch -D spike-{N}`
5. Assert principal still on β

See [references/investigation.md](${CLAUDE_SKILL_DIR}/references/investigation.md) if ∃, else use inline flow above.

## Step 3 — Expert Review

Auto-select ρ (¬ask user):

| ρ | When | Focus |
|---|------|-------|
| doc-writer | Always | Structure, clarity |
| product-lead | Always | Product fit, Outcome quality, Problem↔Outcome alignment |
| architect | ∃ arch / trade-offs / multi-domain | Technical soundness, shape feasibility |
| devops | ∃ CI/CD / deploy / infra | Operational impact |

∀ r ∈ ρ → spawn ∥ `Task(subagent_type: "dev-core:<r>", prompt: "Review α for <focus>. ¬TaskCreate. Return: good / needs improvement / concerns + specific line references.")`.

Incorporate high-confidence feedback into α. Unresolved expert concerns → list in Executive Summary (not AQ).

## Step 4 — Executive Summary (always)

Open α for the user: `code artifacts/analyses/{N}-{slug}-analysis.md` (or print path if `code` unavailable).

Print **exactly this structure** (fill from α + Steps 2–3). HITL surface — **scannable in ≤30s**, not a paste of α.

**Hard size caps (enforce):**
- Intent block: ≤4 short lines total
- Options: one row per shape (2–3 max), every cell ≤1 line
- Recommendation: ≤3 lines
- Evidence / χ / Experts: ≤3 bullets each (or `none` / `clean`)
- Forbidden in summary: verbatim Source quote, full Pro/Con lists, file dumps, diagram markup

```markdown
## Analysis — Executive Summary

**#{N}** — {title}
`artifacts/analyses/{N}-{slug}-analysis.md` · **{τ}** · src `{φ short path}`{ · visuals: `shapes.html` `data-flow.html` if ∃}

### Intent
**Solve:** {1–2 sentences — what is broken / missing today; why now}
**Done when:** {Outcome — one observable sentence, ¬solution}
**Appetite:** {time budget}

### Options
| # | Shape | Bet | Scope | Verdict |
|---|-------|-----|-------|---------|
| 1 | {name} | {what it buys — one line} | {XS…XL} | ✓ recommended |
| 2 | {name} | … | … | ✗ {killed by: constraint} |

### Recommendation
**{shape name}** — {1–2 sentences: why it fits appetite + constraints}
**Trade-off accepted:** {the main con we take on}

### Gates
**Evidence:** {≤3 bullets — files/patterns found, spike result, files-impacted count}
**χ ({n}):** {each short, or "none"}
**Experts:** {clean | ≤3 unresolved}

---
**Your move (free text — no menu):**
approve / ok → commit + advance · shape 2 / change … → revise + re-print · question … → answer · spike {unknown} · re-analyze
```

**STOP this turn** after printing the summary. Do not commit. Do not invoke `/spec`. Do not AskUserQuestion.

## Step 5 — React (free-form chat)

On the user's next message, interpret intent (no AQ):

| Intent signals (examples) | Action |
|---------------------------|--------|
| approve, ok, LGTM, go, good, looks good | → **Approve path** |
| shape 2 / prefer … / change / drop / add / reframe the trade-off | Edit α (incl. Fit Check + sidecars) → re-print Executive Summary → **stop again** |
| question / why / what about / clarify … | Answer in chat; revise α only if they also request a change |
| spike … / test that / prove it | Run Step 2.5 spike → fold findings into α → re-print summary → **stop again** |
| re-analyze / start over / regenerate | Re-run from Step 2 (fresh exploration + interview) |
| abort / stop / cancel | Stop; leave α on disk; return cancel to `/dev` if applicable |

Ambiguous free text → ask **one short prose clarifying question** in the message (plain text). Still ¬AskUserQuestion.

### Approve path

1. Commit: `git add artifacts/analyses/{N}-{slug}-analysis.md artifacts/visuals/` + commit per CLAUDE.md Rule 5.
2. Update issue status:
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set <N> --status Analysis
```
3. Exit per Exit section.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| No frame found | Prose stop + how to provide φ (`/frame --issue N` or `--frame path`) |
| ∃ brainstorm (¬analysis) | Treat as seed, promote via interview (¬AQ) |
| ∃ analysis | Reuse + exec summary; re-analyze on request |
| Expert subagent fails | Report under **Experts**; continue without that reviewer |
| Tier S | Skip Shapes + Fit Check → Options table = `— (Tier S)` |
| Frame lacks appetite | Ask during interview Phase 1; still unknown → **Appetite:** `unset` + χ |
| Only 1 viable shape | Options table with 1 row + one line saying why alternatives died |
| \|χ\| > 3 | List top 3 in summary + `+{n-3} in file` |

## Chain Position

- **Phase:** Shape
- **Predecessor:** `/frame` (artifact: `artifacts/frames/{N}-{slug}-frame.md`)
- **Successor:** `/spec`
- **Class:** `adv` — `/dev`'s type system is single-valued per step (`gate ∈ {frame, spec, plan}`, all others `adv`). The **chat Executive Summary** stop is *skill-internal* (same shape as `/spec`'s gate, same shape as `/recheck`'s self-managed block). From `/dev`'s perspective, `/analyze` stays `adv`.

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

## Exit

The Step 4 Executive Summary is **always** printed (incl. under `/dev`) — it is the gate output, not a closing recap.

- **While waiting for reaction:** turn ends after the Executive Summary. Task stays in progress from `/dev`'s POV until approve/abort.
- **Approved via `/dev`:** commit, return control silently. ¬second summary. ¬ask "proceed to /spec?". `/dev` re-scans and advances.
- **Approved standalone:** print one line: `Approved. Next: /spec --issue N`. Stop.
- **Revise loop:** re-print Executive Summary after each edit; stop again.
- **Abort:** return → `/dev` marks task `cancelled`.
- **Failure:** return error. `/dev` presents Retry | Skip | Abort.

$ARGUMENTS
