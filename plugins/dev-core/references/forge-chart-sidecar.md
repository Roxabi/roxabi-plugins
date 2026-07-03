# Forge-Chart Sidecar — dev-core visual standard

SSoT for architecture and data-flow visuals in dev-core shape artifacts. Read before generating any diagram in `clarify`, `analyze`, `spec`, or `plan`.

## Rule

¬inline mermaid. ¬ASCII art. ¬chat-only diagram blocks for node-edge / architecture / data-flow content.

∀ visual requirement → **forge-chart sidecar**: generate HTML via the `forge-chart` skill, copy into the repo, link from the artifact (or chat recap).

## Prerequisite

Forge plugin installed:

```bash
claude plugin install forge
```

¬installed → STOP + ask user to install forge before continuing past Step 2 of the owning skill.

## Pipeline (mandatory)

1. **Delegate** — `Skill(skill: "forge-chart", args: "{topic} — {diagram kind} for issue #{N}")`
2. **Generate** — fd-engine path for node-edge architecture (`type:"architecture"` or `"hub-spoke"`, `theme:"lyra-v2"`) via `scripts/gen-fd.py`; fgraph `lane-swim` for multi-actor sequences; HTML `<table>` only for pure tabular matrices (no edges).
3. **Validate** — `validate-fd.py` exit 0 before copying (forge-chart Deliver gate).
4. **Copy sidecar** — from forge output to versioned repo path:

```bash
mkdir -p artifacts/visuals
cp ~/.roxabi/forge/<project>/visuals/<slug>.html artifacts/visuals/<filename>.html
```

5. **Link** — in the artifact or chat recap (¬embed the HTML inline):

```markdown
**Diagram:** [{title}](../visuals/{N}-{slug}-{kind}.html)
```

Open locally: `file://{absolute-path}/artifacts/visuals/{filename}.html`

## Filename convention

`{N}-{slug}-{kind}.html`

| `kind` | Used by | forge-chart type |
|--------|---------|------------------|
| `boundary` | `clarify` §2 | `architecture` — actors + boundary |
| `shapes` | `analyze` §Shapes | `architecture` — shape comparison (zones per shape) |
| `data-flow` | `analyze` §Fit Check, `plan` §Architecture | `architecture` + optional `useCases[]` |
| `data-model` | `spec` §Data Model | fgraph `layered` — entities/fields/relations |
| `consumers` | `spec` §Data Model | `hub-spoke` or `architecture` — data center + consumers |
| `file-map` | `plan` §Architecture | `architecture` — files as nodes, call edges |

`N` optional when no issue (free-text clarify) → `{slug}-{kind}.html`.

## Section mapping

| Skill | Section | Sidecar required when |
|-------|---------|----------------------|
| `clarify` | §2 Business Architecture | always (≥2 actors or layers) |
| `analyze` | §Shapes | F-lite/F-full, ≥2 shapes |
| `analyze` | §Fit Check | F-lite/F-full, data flow or arch choice |
| `spec` | §Data Model & Consumers | F-lite/F-full |
| `plan` | §Architecture | always (τ ∈ {F-lite, F-full}) |

Tier S may omit shape/fit sidecars in `analyze`; may omit Data Model sidecars in `spec`.

## Text flows in clarify §3

Actor chains (`Actor → action → layer → outcome`) stay as one-line text — they are UX flows, not topology diagrams. ¬convert to mermaid/ASCII boxes.

## Consumer summary table

Keep the markdown table in `spec` §Data Model (consumer → fields → when → status). The sidecar is the visual; the table is the machine-readable index.

## Quality bar

Match forge-chart Craft Quality Bar (lyra-diagram gold standard): premium cards, bezier edges, `glow` on hub, `flow` on passive edges, per-node icons where helpful. See `forge-chart` SKILL.md § Craft Quality Bar.