# frame

Problem framing — capture the problem, constraints, scope, and tier before writing any code.

## Why

Jumping straight to implementation without a clear problem statement leads to scope creep and rework. `/frame` forces a structured interview, produces an approved frame artifact, and auto-detects the implementation tier (S / F-lite / F-full) so the rest of the pipeline is correctly scoped.

## Usage

```
/frame "idea text"      Frame a free-text idea
/frame --issue 42       Seed from a GitHub issue
```

Triggers: `"frame"` | `"frame this"` | `"what's the problem"` | `"define the problem"` | `"scope this out"` | `"problem statement"`

## How it works

1. **Parse + Seed** — reads the GitHub issue (title, body, labels) or free text as context.
2. **Interview** — asks 3–5 focused questions (skips what's already clear from the issue body): problem/pain, affected users, constraints, out-of-scope, related work.
3. **Premise-validity gate** — required before tier classification. Captures three fields:
   - `success_in_6mo` — what does success look like? (concrete, observable)
   - `failure_in_6mo` — what does failure look like? (must be falsifiable)
   - `simplest_alternative` + why it's insufficient — forces explicit comparison against the minimal solution
   Cannot proceed without all three. Non-falsifiable failure modes trigger an abort prompt.
4. **Tier detection** — infers S / F-lite / F-full from complexity signals (file count, domain breadth, unknowns); lets you override.
5. **Write frame doc** — creates `artifacts/frames/{N}-{slug}-frame.mdx` with status: `draft`.
6. **User approval** — presents the frame for confirmation; loops on revisions until approved.
7. **Commit + status update** — sets issue status to `Analysis` and commits the artifact.

## Output artifact

```
artifacts/frames/{N}-{slug}-frame.mdx
```

Fields: `title`, `issue`, `status: approved`, `tier`, `date`, Problem, Who, Constraints, Out of Scope, Premise Validity (required: `success_in_6mo`, `failure_in_6mo`, `simplest_alternative` + why-not), Complexity.

## Chain position

Frame → **Predecessor of** `/analyze` (F-full) or `/spec` (F-lite).
