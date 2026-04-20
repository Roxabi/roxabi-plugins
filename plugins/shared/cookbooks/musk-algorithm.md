# Musk's Algorithm Cookbook for ~/projects

**Goal:** Apply the 5-step anti-bureaucracy algorithm to the roxabi ecosystem.

**Order is non-negotiable:** Question → Delete → Simplify → Accelerate → Automate

---

## Phase 1: Question Every Requirement

### 1.1 Daemon Inventory

For each running daemon, answer:

| Question | Answer |
|----------|--------|
| Who requested this? | Name or "self-inflicted" |
| What breaks if it stops? | Concrete downstream impact |
| Last time it was used? | Date or "unknown" |
| Still worth the RAM/CPU? | Yes/No/TBD |

**Command to list all:**

```bash
make ps  # from ~/projects
```

**Candidates to question first:**
- Low-traffic bots (discord vs telegram usage?)
- Redundant services (multiple LLM proxies?)
- Monitoring that nobody reads

### 1.2 Makefile Target Inventory

```bash
# List all make targets
make help  # or grep -E '^[a-z].*:' Makefile | head -50
```

For each target:

| Target | Who uses it? | Last used? | Keep? |
|--------|--------------|------------|-------|
| `make start` | You | Daily | ✅ |
| `make something-obscure` | ??? | ??? | ❓ |

**Rule:** If you can't remember who uses it, flag for deletion.

### 1.3 Dependency Inventory

For each `pyproject.toml` in projects:

```bash
find ~/projects -name "pyproject.toml" -exec grep -l "dependencies" {} \;
```

Per dep, ask:
- Is it imported? (`grep -r "import <dep>" <project>/src`)
- Is it still maintained? (last commit date)
- Could a simpler alternative work?

---

## Phase 2: Delete (Before Optimizing)

### 2.1 The 10% Rule

> "If you don't add back 10%, you didn't delete enough."

**Target:** Cut more than feels safe.

### 2.2 Deletion Checklist

**Daemons:**

```bash
# Stop and disable
make <svc> stop
# Edit supervisord config to remove or set autostart=false
# If truly dead: remove from conf.d/*.mk, delete program section
```

**Makefile targets:**

```bash
# Comment out or delete unused targets
# Keep for 1 week, then remove if no complaints (from yourself)
```

**Dependencies:**

```bash
# Remove from pyproject.toml, run uv sync
# If import errors: add back (that's the 10%)
```

**Stale files:**

```bash
# Find unused Python modules
find ~/projects -name "*.py" -mtime +365 -exec ls -la {} \;
# Find empty dirs
find ~/projects -type d -empty
```

### 2.3 Track What You Cut

Create a "deletion log":

```markdown
## Deletions (2026-04-20)

| Item | Type | Reason | Added back? |
|------|------|--------|-------------|
| `dashboard` | Service | Unused | No |
| `gitnexus` | Service | Unused | No |
| `uptime` | Service | Unused | No |
| `comfyui` | Service | Unused | No |

---

## Phase 4 Results (2026-04-20)

| Improvement | Before | After | Saved |
|-------------|--------|-------|-------|
| **pytest-xdist** | 85s sequential | 38s parallel | 47s (55%) |
| **numpy dep** | 3 tests blocked | 0 blocked | ✅ |

**Known issue:** `test_set_bot_settings_raises_on_missing_row` has 30s teardown. This is a pytest-asyncio event loop shutdown issue (not aiosqlite). Only affects 1 test, parallel execution hides it.

---
```

---

## Phase 3: Simplify & Optimize

**Only after Phase 1-2 complete.**

### 3.1 Config Consolidation

| Current State | Simplified State |
|---------------|------------------|
| Multiple `.env` files per project | Shared `.env` for common vars |
| Per-project supervisor configs | Symlinked shared sections |
| Ad-hoc logging paths | Unified `~/logs/<project>/` |

### 3.2 Pattern Standardization

- CLAUDE.md templates
- pyproject.toml boilerplate
- Makefile grammar (`make <svc> start|stop|logs`)

### 3.3 Optimize Hot Paths

What do you run 10x/day?

| Path | Current | Optimized |
|------|---------|-----------|
| `uv sync` | Full resolve | Cache hits only |
| `make ps` | supervisorctl call | Alias? |
| Deploy to prod | Manual steps | One command? |

---

## Phase 4: Accelerate Cycle Time

**Only after Phases 1-3.**

### 4.1 Build/Test Speed

```bash
# Profile test suite
pytest --durations=20
# Parallelize
pytest -n auto
```

### 4.2 Hot Reload

- `make reload-config` already exists for supervisor
- Can services auto-reload on config change?

### 4.3 CI/CD Cycle

- Current: push → wait → merge
- Faster: parallel jobs, caching, smaller test matrix

---

## Phase 5: Automate

**Only after Phases 1-4.**

### 5.1 What to Automate

| Manual Process | Automation |
|----------------|------------|
| Deploy steps | `make deploy` (exists) |
| Log checking | Alerts on ERROR patterns |
| Dependency updates | Renovate/dependabot |
| Config sync | `make forge sync` (exists) |

### 5.2 Automation Traps

- Don't automate what you haven't deleted
- Don't automate what you haven't simplified
- Every automation = maintenance burden

---

## Execution Plan

**Do not skip phases. Do not parallelize.**

| Day | Focus |
|-----|-------|
| 1 | Phase 1: Inventory everything, attach owners |
| 2 | Phase 2: Delete aggressively (track in log) |
| 3 | Phase 2: Continue deleting, note 10% add-backs |
| 4 | Phase 3: Simplify what survived |
| 5 | Phase 3: Optimize hot paths |
| 6+ | Phase 4-5: Only if 1-3 are solid |

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────┐
│  MUSK'S ALGORITHM — CHEAT SHEET                 │
├─────────────────────────────────────────────────┤
│  1. QUESTION  →  Who asked? Name required.      │
│  2. DELETE    →  Cut 10% more than safe.        │
│  3. SIMPLIFY  →  Only after deletion.           │
│  4. ACCELERATE→  Speed what survived.           │
│  5. AUTOMATE  →  Last, not first.               │
├─────────────────────────────────────────────────┤
│  COMMON MISTAKES:                               │
│  × Automate before deleting                     │
│  × Optimize a process that shouldn't exist      │
│  × Accept "legal department" as an owner        │
│  × Skip questioning smart people's requirements │
└─────────────────────────────────────────────────┘
```

---

**Sources:** Isaacson's Musk biography via Corporate Rebels blog (2023-11-12)
