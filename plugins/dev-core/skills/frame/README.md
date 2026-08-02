# frame

Problem framing — capture the problem, constraints, scope, and tier before writing any code.

## Why

Jumping straight to implementation without a clear problem statement leads to scope creep and rework. `/frame` produces an approved frame artifact and auto-detects the implementation tier (S / F-lite / F-full) so the rest of the pipeline is correctly scoped.

## Usage

```
/frame "idea text"      Frame a free-text idea
/frame --issue 42       Seed from a GitHub issue
```

Triggers: `"frame"` | `"frame this"` | `"what's the problem"` | `"define the problem"` | `"scope this out"` | `"problem statement"`

## How it works

**Policy: auto when unambiguous; AQ only for real gaps.**

1. **Parse + Seed** — reads the GitHub issue (title, body, labels) or free text.
   - Approved frame already on disk → **reuse**, exit (no re-approve).
   - Draft exists → **continue** (no "Start fresh?" prompt).
2. **Interview** — asks only fields missing from the seed (0 questions when the issue body is rich).
3. **Premise-validity gate** — three fields (`success_in_6mo`, `failure_in_6mo`, `simplest_alternative` + why-not). Extract from seed/draft when present; AQ only for missing fields. Non-falsifiable failure modes still trigger an abort prompt.
4. **Tier detection** — from size label or unanimous signals → auto. Contested signals only → Confirm AQ.
5. **Write frame doc** — `artifacts/frames/{N}-{slug}-frame.md` with status: `draft`.
6. **Approval** — **auto-approve** when interview/premise/tier had zero AQs this run; otherwise Approve | Revise.
7. **Commit + status update** — sets issue status to `Analysis` and commits the artifact.

## Output artifact

```
artifacts/frames/{N}-{slug}-frame.md
```

Fields: `title`, `issue`, `status: approved`, `tier`, `date`, Problem, Who, Constraints, Out of Scope, Premise Validity (required: `success_in_6mo`, `failure_in_6mo`, `simplest_alternative` + why-not), Complexity.

## Chain position

Frame → **Predecessor of** `/analyze` (F-full) or `/spec` (F-lite).
