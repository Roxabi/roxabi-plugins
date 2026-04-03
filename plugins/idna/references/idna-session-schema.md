# session.json — Schema + State Machine

## Full Schema

```json
{
  "id": "<project>-<subject>-001",
  "type": "avatar | voice | text | logo | ...",
  "subject": "human-readable subject description",

  "phase": "explore | converge | finalize",
  "round": 0,
  "status": "ready | generating | done | error",
  "progress": null,
  "error": null,

  "identity": "Fixed description that never changes across variants.",

  "winner": null,
  "runner_up": null,
  "cycle_winners": [],

  "rounds": [
    {
      "round": 0,
      "phase": "explore",
      "picked": null,
      "variants": [
        {
          "id": "v0", "label": "V0",
          "params": { "expression": "...", "lighting": "...", "framing": "...", "mood": "..." },
          "image": "round_0/v0.png"
        }
      ]
    }
  ]
}
```

## Field Notes

| Field | Description |
|-------|-------------|
| `identity` | Fixed physical/conceptual description shared by all variants. Never mutated. |
| `winner` | Current best pick. Updated on each pick. Has: `id, label, round, image, params, prompt`. |
| `runner_up` | Second-best, used for blend mutations. Optional. |
| `cycle_winners` | History of winners per round — for plateau detection. |
| `progress` | Sub-status during generation: `asking_claude → encoding → generating_images` |

## State Machine

```
ready ──pick──► generating
                    │
                    ├─ asking_claude
                    ├─ encoding
                    └─ generating_images
                            │
                         ready (next round)
                            │
                         done (after finalize)
```

## Phase Transitions

| Phase | Trigger | Next |
|-------|---------|------|
| `explore` | Pick from 4 variants | `converge` (round 1) |
| `converge` | Pick from 3 variants (amplify/blend/refine) | `converge` (round N+1) |
| `converge` | POST /api/finalize | `finalize` → `done` |

## Round Structure

- **Round 0** — explore: 4 variants (`v0`–`v3`), seeds `0`–`3`
- **Round N** (converge) — 3 variants (`va`, `vb`, `vc`), seeds `N×100`–`N×100+2`
- Mutations: `va=amplify`, `vb=blend`, `vc=refine`

## Variant params (image type)

```json
{
  "expression": "...",
  "lighting": "...",
  "framing": "...",
  "mood": "..."
}
```

## Variant params (voice type)

```json
{
  "tone": "...",
  "pace": "...",
  "affect": "...",
  "style": "..."
}
```
