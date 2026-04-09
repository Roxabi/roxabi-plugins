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
3. **Tier detection** — infers S / F-lite / F-full from complexity signals (file count, domain breadth, unknowns); lets you override.
4. **Write frame doc** — creates `artifacts/frames/{N}-{slug}-frame.mdx` with status: `draft`.
5. **User approval** — presents the frame for confirmation; loops on revisions until approved.
6. **Commit + status update** — sets issue status to `Analysis` and commits the artifact.

## Output artifact

```
artifacts/frames/{N}-{slug}-frame.mdx
```

Fields: `title`, `issue`, `status: approved`, `tier`, `date`, Problem, Who, Constraints, Out of Scope, Complexity.

## Chain position

Frame → **Predecessor of** `/analyze` (F-full) or `/spec` (F-lite).
