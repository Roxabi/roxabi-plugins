# adversarial

Standalone red-team / devil's advocate for design-phase work — analyses, proposals, architecture choices, ideas, specs, and plans.

## Why

Friendly review optimizes for shipping. Adversarial review tries to **kill the claim**: unstated assumptions, vacuous success criteria, bypass paths, partial-failure ordering, and scope that passes while the real problem remains. Better to break the idea on paper than after implement.

Distinct from `/dev-review`, which already embeds the adversarial *agent* on PR diffs. This skill is the entry point when there is no PR yet — only a shape, proposal, or argument.

## Usage

```
/adversarial "we should pin every workflow to main"
/adversarial --issue 374
/adversarial --analysis artifacts/analyses/374-release-gate-analysis.md
/adversarial --spec artifacts/specs/374-release-gate-spec.md --write
```

Triggers: `"adversarial"` | `"red team"` | `"devil's advocate"` | `"attack this design"` | `"kill this idea"` | `"stress test this"` | `"what breaks this"`

## How it works

1. **Resolve** — free text, issue (+ artifacts), or explicit path.
2. **Scope** — name the priced claim (what must be true if we adopt this).
3. **Attack** — spawn the `adversarial` agent with shape-aware lens guidance.
4. **Present** — findings ordered fatal → major → minor; survivors called out.
5. **Write** (optional `--write`) — `artifacts/reviews/{N}-{slug}-adversarial.md`.

## Lenses (agent)

| Lens | Question |
|------|----------|
| bypass | How does the control go green while the bad state remains? |
| fleet-regression | Does this break other repos / paths that should stay green? |
| operational | Race, ordering, vacuous assert, partial failure |
| assumption-kill | What unstated assumption falsifies the design? |
| vacuous-guard | Does the check measure the priced quantity or a cheap proxy? |
| scope-attack | Can this ship while the problem is still unsolved? |

## Related skills

| Skill | Posture |
|-------|---------|
| `/adversarial` | Kill the design |
| `/advisory` | Strengthen and advise (constructive) |
| `/dev-review` | Diff/PR multi-domain review (includes adversarial agent) |
| `/analyze` | Structured shape exploration (no attack) |
