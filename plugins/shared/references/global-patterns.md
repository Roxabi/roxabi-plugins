# Global Patterns

Always-on behavioral rules for any project with dev-core installed.

Let: α := agent | τ := tier | ω := worktree | DP := decision protocol

---

## 1. Decision Protocol

∀ decision, choice (≥2 options), approach proposal:

```
── Decision: {topic} ──
Context:     {why / root cause / current state / trigger}
Target:      {what we're trying to achieve}
Path:        {how we get there once chosen}

Options:
  1. {option} — {one-line description}
  2. {option} — {one-line description}   ← recommended
Recommended: Option N — {1-line rationale}
```

→ Wait for reply. Execute immediately. ¬confirmation loop.

Plain input needed (URL, path, text) → ask directly in 1–2 sentences (¬full block).
Multi-select / batch → numbered list + "Enter numbers comma-separated".

---

## 2. Agent Discipline

Spawn the right α **as soon as the domain is clear** — ¬wait for work to pile up.
¬write code, docs, or tests in main context — delegate to α.
Main context = coordination, decisions, summaries. α = implementation.

| Domain | α |
|--------|---|
| UI, components, pages | `frontend-dev` |
| API, DB, services | `backend-dev` |
| Infra, CI/CD, config | `devops` |
| Documentation | `doc-writer` |
| Bug fixes, review comments | `fixer` |
| Tests, coverage | `tester` |
| System design | `architect` |
| Requirements, specs | `product-lead` |
| Security | `security-auditor` |

F-full + ≥4 independent tasks in 1 domain → spawn multiple same-type α on separate file groups.

Shared α rules: ¬force/hard/amend | stage specific files only | escalate blockers → lead | message lead on completion.

---

## 3. Context Discipline

∀ implementation task → spawn α, ¬inline.
¬accumulate large code blocks in main context.
∥ independent α → single message with multiple Agent tool calls.
α result → summarize to user (¬dump raw output).

---

## 4. Dev Process

All work → `/dev #N` (orchestrates τ, artifacts, ω, α team).
τ determined by plugin — ¬re-classify manually.

| τ | Trigger | Flow |
|---|---------|------|
| S | ≤3 files, single domain, ¬unknowns | direct impl → PR |
| F-lite | Clear scope, 4–10 files | frame → spec → plan → impl → verify → ship |
| F-full | Multi-domain, new arch, unknowns | frame → analyze → spec → plan → impl → verify → ship |

Artifacts: `artifacts/frames/` | `artifacts/analyses/` | `artifacts/specs/` | `artifacts/plans/`

---

## 5. Worktree

| τ | ω |
|---|---|
| S | Optional |
| F-lite | Mandatory |
| F-full | Mandatory |

¬code on main/staging without ω (F-lite/F-full).
XS exception: single-line fix, confirm with user first.

---

## 6. Parallel Execution

≥3 independent tasks → DP(A): **Sequential** | **Parallel** (Recommended).
∥ tasks must be truly independent (¬shared state, ¬ordering deps).

---

## 7. Git

Format: `<type>(<scope>): <desc>`
Types: `feat|fix|refactor|docs|style|test|chore|ci|perf`

¬`--force` | ¬`--hard` | ¬`--amend`. Hook fail → fix + NEW commit.
