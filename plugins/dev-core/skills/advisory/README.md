# advisory

Constructive expert second opinion on design-phase work — analyses, proposals, architecture, ideas, specs, and plans.

## Why

Sometimes you do not need a red-team kill shot or a three-way consensus debate. You need advisors who say: what to keep, what to strengthen first, how to reduce risk without throwing the design away, and what to do next. `/advisory` is that posture.

## Usage

```
/advisory "split the gate into price vs enforce stages"
/advisory --issue 374
/advisory --analysis artifacts/analyses/374-release-gate-analysis.md
/advisory --path docs/architecture/proposal.md --write
```

Triggers: `"advisory"` | `"second opinion"` | `"advise on this"` | `"strengthen this"` | `"expert advice"` | `"what would you improve"`

## How it works

1. **Resolve** — free text, issue (+ artifacts), or path.
2. **Select advisors** — always `architect` + `product-lead`; optional third (`devops`, `security-auditor`, domain) from context.
3. **Advise in parallel** — each returns Keep / Strengthen (P0–P2) / Risks→advice / Open Qs / Next.
4. **Synthesize** — one memo; conflicts on P0 are surfaced, not papered over.
5. **Write** (optional `--write`) — `artifacts/reviews/{N}-{slug}-advisory.md`.

## Related skills

| Skill | Posture |
|-------|---------|
| `/advisory` | Strengthen and prioritize |
| `/adversarial` | Kill the design (red-team) |
| `/consensus` | Multi-expert debate → one recommendation |
| `/clarify` | Intent-first recap across layers |
| `/analyze` | Full shape exploration + expert review gate |
