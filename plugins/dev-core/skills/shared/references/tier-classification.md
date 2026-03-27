# Tier Classification

Let: τ := tier | C := complexity score (1–10) | α := agent

Canonical rules for classifying work into S / F-lite / F-full. Referenced by `/frame`, `/dev`, `/issue-triage`.

## Scale

| τ | Description |
|---|-------------|
| **S** | Simple + small. ≤3 files, single domain, ¬new arch, ¬unknowns. Single session, ¬α spawning. |
| **F-lite** | Focused feature. Clear scope, single domain, ¬major unknowns. 1–2 domain α + tester. |
| **F-full** | Full feature. Multiple domains, new patterns/arch, unknowns, ∨ XL size. Full α team, test-first. |

## Detection Signals

| Signal | Infers |
|--------|--------|
| ≤3 files, single domain, ¬new arch, ¬unknowns | S |
| Clear scope, single domain, 4–10 files, known patterns | F-lite |
| Multiple domains, new patterns, unknowns, ∨ arch impact | F-full |
| Issue label XS ∨ S | S |
| Issue label M | F-lite |
| Issue label L ∨ XL | F-full |

## Complexity Scoring (via /issue-triage)

**Factors (weighted):**

| Factor | Weight | 1 (Low) | 5 (Med) | 10 (High) |
|--------|--------|---------|---------|-----------|
| Files touched | 20% | 1–3 | 5–10 | 15+ |
| Technical risk | 25% | Known patterns | New lib in 1 domain | New arch |
| Arch impact | 25% | Single module | Shared types, 2 modules | Cross-domain, new abstractions |
| Unknowns | 15% | 0 | 1–2 open questions | 3+ |
| Domain breadth | 15% | 1 domain | 2 domains | 3+ domains |

**Formula:** `round(files × 0.20 + risk × 0.25 + arch × 0.25 + unknowns × 0.15 + domains × 0.15)`

**τ mapping:**

| C | τ | Process | α Mode |
|---|---|---------|--------|
| 1–3 | **S** | Worktree + direct impl + PR | Single session, ¬α |
| 4–6 | **F-lite** | Worktree + subagents + /code-review | Task subagents (1–2 domain + tester) |
| 7–10 | **F-full** | Bootstrap + worktree + α team + /code-review | TeamCreate (3+ α, test-first) |

## Resolution Rules

- C + signals agree → use that τ.
- C + signals conflict → default **higher** τ, note: "Defaulted to {τ} — downgrade if scope narrows."
- Human judgment always overrides. AskUserQuestion if C + intuition disagree.
- Scope vs complexity: small but complex fix (1 file, tricky logic) stays S. Large but simple change (10 files, config tweak) may stay F-lite.
