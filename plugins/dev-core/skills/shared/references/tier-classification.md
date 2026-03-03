# Tier Classification

Canonical rules for classifying work into S / F-lite / F-full tiers. Referenced by `/frame`, `/dev`, and `/issue-triage`.

## Scale

| Tier | Description |
|------|-------------|
| **S** | Simple + small. ≤3 files, single domain, no new architecture, no unknowns. Single session, no agent spawning. |
| **F-lite** | Focused feature. Clear scope, single domain, no major unknowns. 1-2 domain agents + tester. |
| **F-full** | Full feature. Multiple domains, new patterns/architecture, unknowns, or XL size. Full agent team, test-first. |

## Detection Signals

| Signal | Infers |
|--------|--------|
| ≤3 files mentioned, single domain, no new arch, no unknowns | S |
| Clear scope, single domain, 4-10 files, known patterns | F-lite |
| Multiple domains, new patterns, unknowns, or architectural impact | F-full |
| Issue label XS ∨ S | S |
| Issue label M | F-lite |
| Issue label L ∨ XL | F-full |

## Complexity Scoring (via /issue-triage)

**Factors (weighted):**

| Factor | Weight | 1 (Low) | 5 (Medium) | 10 (High) |
|--------|--------|---------|------------|-----------|
| Files touched | 20% | 1-3 | 5-10 | 15+ |
| Technical risk | 25% | Known patterns | New library in 1 domain | New architecture |
| Architectural impact | 25% | Single module | Shared types, 2 modules | Cross-domain, new abstractions |
| Unknowns count | 15% | 0 | 1-2 open questions | 3+ |
| Domain breadth | 15% | 1 domain | 2 domains | 3+ domains |

**Formula:** `round(files × 0.20 + risk × 0.25 + arch × 0.25 + unknowns × 0.15 + domains × 0.15)`

**Tier mapping:**

| Score | Tier | Process | Agent Mode |
|-------|------|---------|-----------|
| 1-3 | **S** | Worktree + direct impl + PR | Single session, no agents |
| 4-6 | **F-lite** | Worktree + subagents + /review | Task subagents (1-2 domain + tester) |
| 7-10 | **F-full** | Bootstrap + worktree + agent team + /review | TeamCreate (3+ agents, test-first) |

## Resolution Rules

- Score and signals agree → use that tier.
- Score and signals conflict → default to **higher** tier, note in frame doc: "Defaulted to {τ} — downgrade if scope narrows."
- Human judgment always overrides. Use `AskUserQuestion` if score and intuition disagree.
- Scope vs. complexity: a small but complex fix (1 file, tricky logic) stays at S. A large but simple change (10 files, config tweak) may stay at F-lite.
