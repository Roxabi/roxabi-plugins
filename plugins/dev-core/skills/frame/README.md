# frame

Problem framing — capture the problem, constraints, scope, and tier before writing any code.

## Why

Jumping straight to implementation without a clear problem statement leads to scope creep and rework. `/R-frame` produces an approved frame artifact and auto-detects the implementation tier (S / F-lite / F-full) so the rest of the pipeline is correctly scoped.

## Usage

```
/R-frame "idea text"      Frame a free-text idea
/R-frame --issue 42       Seed from a GitHub issue
```

Triggers: `"frame"` | `"frame this"` | `"what's the problem"` | `"define the problem"` | `"scope this out"` | `"problem statement"`

## How it works

**Policy: auto when high confidence; chat-native HITL otherwise (¬AskUserQuestion).**

1. **Parse + Seed** — reads the GitHub issue (title, body, labels) or free text.
   - Approved frame already on disk → **reuse**, exit (no re-approve).
   - Draft exists → **continue** (no "Start fresh?" prompt).
2. **Interview** — extract only fields present in the seed; remaining gaps → χ (no menus).
3. **Premise-validity gate** — three fields (`success_in_6mo`, `failure_in_6mo`, `simplest_alternative` + why-not). Extract from seed/draft when present; missing → χ. Proxy-metric failure modes surface as an abort **signal** in the summary (free-form reframe/abort).
4. **Tier detection** — from size label or unanimous signals → auto. Contested signals → default higher τ + flag in Gates (override in free text).
5. **Write frame doc** — `artifacts/frames/{N}-{slug}-frame.md` with status: `draft`.
6. **Approval**
   - **high confidence** (no interview/premise gaps, tier not contested, no abort signal) → **auto-approve** + short summary + commit.
   - otherwise → **Executive Summary** + free-form (`approve` / `change …` / `adversarial` / `advisory` / `re-frame`).
7. **Commit + status update** — sets issue status to `Analysis` and commits the artifact.

## Output artifact

```
artifacts/frames/{N}-{slug}-frame.md
```

Fields: `title`, `issue`, `status: approved`, `tier`, `date`, Problem, Who, Constraints, Out of Scope, Premise Validity (required: `success_in_6mo`, `failure_in_6mo`, `simplest_alternative` + why-not), Complexity.

## Chain position

Frame → **Predecessor of** `/R-analyze` (F-full) or `/R-spec` (F-lite).

Class: `adv + approval stop` with high-conf auto-approve. Disk done-signal = `status: approved`.
