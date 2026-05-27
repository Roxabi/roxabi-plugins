# Musk's Algorithm Cookbook for ~/projects

**Goal:** Apply the 5-step anti-bureaucracy algorithm to the roxabi ecosystem.

**Order is non-negotiable:** Question → Delete → Simplify → Accelerate → Automate

> **Tooling note:** This cookbook reflects the container-first ops standard. Service lifecycle is owned by **systemd user units** (Quadlet-generated), code lifecycle is owned by **uv run** (native dev), and image lifecycle is owned by **podman**. `make` is reserved for atomic multi-step operations (`make install-quadlet`, `make build`, `make test`). See [`~/projects/docs/container-deployment-standard.md`](../../../../docs/container-deployment-standard.md) for the full standard.

---

## Tooling per layer (normative)

| Layer | Tool | Examples |
|---|---|---|
| **Dev/test (fast, hot reload)** | `uv run` natif | `uv run pytest`, `uv run ruff check`, `uv run <tool> serve` |
| **Build / validation E2E** | `podman build` / `podman run` | `podman build -f deploy/Dockerfile.X -t ghcr.io/roxabi/X:dev .` |
| **Ops (long-running services)** | `systemctl --user` | `systemctl --user start/stop/restart <svc>.service` |
| **Logs** | `journalctl --user` | `journalctl --user -u <svc>.service -f` |
| **Service status** | `systemctl --user status` + `podman ps` | direct, no wrappers |
| **Atomic multi-step ops** | `make` | `make install-quadlet`, `make secrets-rotate`, `make build`, `make test`, `make lint` |

**Anti-patterns** (do not use):
- `make <svc> start/stop/logs/status` → use `systemctl --user` directly
- `supervisorctl ...` → supervisord is removed from the ecosystem
- `~/projects/conf.d/*.{mk,conf}` → legacy hub supervisord paths, no longer exist

---

## Phase 1: Question Every Requirement

### 1.1 Service Inventory

For each running service, answer:

| Question | Answer |
|----------|--------|
| Who requested this? | Name or "self-inflicted" |
| What breaks if it stops? | Concrete downstream impact |
| Last time it was used? | Date or "unknown" |
| Still worth the VRAM/RAM/CPU? | Yes/No/TBD |

**Commands to list all:**

```bash
# All user services (Quadlet + native)
systemctl --user list-units --type=service --state=running

# All Podman containers
podman ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}"

# Cross-host (via tailnet MagicDNS)
ssh roxabituwer 'systemctl --user list-units --type=service --state=running'
```

**Candidates to question first:**
- Low-traffic adapters (discord vs telegram usage?)
- Redundant services (multiple LLM proxies?)
- Monitoring/cockpits nobody reads
- Daemons in `inactive dead` for >1 week

### 1.2 Makefile Target Inventory

```bash
# List all make targets
grep -E '^[a-z][a-z_-]*:' Makefile | head -50
```

For each target, classify by **purpose**:

| Target | Purpose | Keep? |
|--------|---------|-------|
| `make install-quadlet` | Atomic ops (copy Quadlet + reload) | ✅ |
| `make build` | Atomic ops (podman build + tag) | ✅ |
| `make test` | Dev sucre (= `uv run pytest`) | ✅ |
| `make lint` | Dev sucre (= `uv run ruff check`) | ✅ |
| `make <svc> start` | Ops wrapper (anti-pattern) | ❌ → systemctl direct |
| `make <svc> logs` | Ops wrapper (anti-pattern) | ❌ → journalctl direct |
| `make register` | Hub supervisord wrapper (legacy) | ❌ delete |

**Rule:** keep `make` for **atomic multi-step ops** (creates secrets + copies files + reloads daemon). Delete `make` wrappers around single-command ops (`systemctl start`, `journalctl -f`).

### 1.3 Dependency Inventory

For each `pyproject.toml`:

```bash
find ~/projects -name "pyproject.toml" -not -path '*/.venv/*' -exec grep -l "dependencies" {} \;
```

Per dep, ask:
- Is it imported? `grep -rn "import <dep>" <project>/src`
- Is it still maintained? (last commit date)
- Could a simpler alternative work?

---

## Phase 2: Delete (Before Optimizing)

### 2.1 The 10% Rule

> "If you don't add back 10%, you didn't delete enough."

**Target:** cut more than feels safe.

### 2.2 Deletion Checklist

**Services (Quadlet):**

```bash
# Stop the service
systemctl --user stop <svc>.service

# Verify nothing else needs it
systemctl --user list-dependencies <svc>.service

# If truly dead — delete the Quadlet file and reload
rm ~/.config/containers/systemd/<svc>.container
systemctl --user daemon-reload

# Optionally remove the secret if no other service uses it
podman secret rm <secret-name>
```

**Native systemd user services (non-Quadlet, legacy):**

```bash
systemctl --user disable --now <svc>.service
rm ~/.config/systemd/user/<svc>.service
systemctl --user daemon-reload
```

**Makefile targets:**

```bash
# Comment out, run for 1 week, delete if no complaint (from yourself)
# Especially: anything that wraps `systemctl` or `journalctl`
```

**Dependencies:**

```bash
# Remove from pyproject.toml, run uv sync
# If import errors: add back (that's the 10%)
```

**Stale files:**

```bash
# Find unused Python modules
find ~/projects -name "*.py" -mtime +365 -not -path '*/.venv/*' -exec ls -la {} \;

# Find empty dirs (excluding .venv, node_modules)
find ~/projects -type d -empty -not -path '*/.venv/*' -not -path '*/node_modules/*'

# Find leftover .bak files in Quadlet dirs
find ~/.config/containers/systemd/ -name '*.bak*'
```

### 2.3 Track What You Cut

Create a "deletion log":

```markdown
## Deletions (YYYY-MM-DD)

| Item | Type | Reason | Added back? |
|------|------|--------|-------------|
| `dashboard` | Service | Unused | No |
| `comfyui` make target | Wrapper | Service archived | No |
| `make <svc> start` family | Wrapper | Use systemctl direct | No |
| `supervisor/` dir | Legacy hub | Replaced by Quadlet | No |
```

---

## Phase 3: Simplify & Optimize

**Only after Phase 1-2 complete.**

### 3.1 Config Consolidation

| Current State | Simplified State |
|---|---|
| `.env` paths divergent (`~/.config/containers/systemd/`, `~/.lyra/env/`, `~/.roxabi/<tool>/`) | Standard: `~/.roxabi/<tool>/env/<role>.env` (grandfathered: `~/.lyra/env/`) |
| Secret naming heterogeneous (`lyra-nkey-*`, `<tool>-nats-nkey`) | By TYPE: `<tool>-nats-<role>`, `<tool>-<svc>-key`, `<tool>-<type>-pem` |
| Ad-hoc logging paths | Unified: `journalctl --user -u <svc>` only |
| Repo-specific Dockerfile location (root vs `deploy/`) | Standard: `deploy/Dockerfile.<role>` |

### 3.2 Pattern Standardization

Standards documented in [`~/projects/docs/container-deployment-standard.md`](../../../../docs/container-deployment-standard.md):

- Manifest TOML per repo: `deploy/quadlet.toml`
- Host topology: `~/projects/hosts.toml`
- Idempotent deploy: `~/projects/deploy.sh`
- Config layering: TOML (user) / `.env` (system) / Quadlet inline (constants) / Podman Secret (crypto)

### 3.3 Optimize Hot Paths

What do you run 10x/day?

| Path | Current | Optimized |
|------|---------|-----------|
| `uv sync` | Full resolve | `UV_FROZEN=1 uv sync` (cache hits only) |
| List services | `systemctl --user list-units --type=service` | Alias `slsu` if frequent |
| Tail logs | `journalctl --user -u <svc> -f` | Alias `jl <svc>` if frequent |
| Cross-host status | `ssh roxabituwer systemctl --user status …` | Alias / script if frequent |
| Deploy to prod | Manual host SSH + commands | `~/projects/deploy.sh --diff` then apply |

---

## Phase 4: Accelerate Cycle Time

**Only after Phases 1-3.**

### 4.1 Build/Test Speed

```bash
# Profile test suite
uv run pytest --durations=20

# Parallelize
uv run pytest -n auto

# Container build cache
podman build --cache-from ghcr.io/roxabi/<tool>:staging -t ghcr.io/roxabi/<tool>:dev .
```

### 4.2 Hot Reload

For services managed via Quadlet:

```bash
# Code change in image → rebuild + restart
podman build -f deploy/Dockerfile.<role> -t ghcr.io/roxabi/<tool>:dev . \
  && systemctl --user restart <svc>.service

# Config change in env file
# Just edit ~/.roxabi/<tool>/env/<role>.env then:
systemctl --user restart <svc>.service

# Quadlet file change
systemctl --user daemon-reload
systemctl --user restart <svc>.service
```

For dev itération (no container rebuild):

```bash
# Mount source into a running dev container
podman run --rm -v ./src:/app/src ghcr.io/roxabi/<tool>:dev
# Or run natively
uv run <tool> serve
```

### 4.3 CI/CD Cycle

- Current: push → wait → merge → autoupdate timer pulls (~5 min on M₁)
- Faster: parallel CI jobs, layer caching, smaller test matrix
- Image autoupdate via `Label=io.containers.autoupdate=registry` + `podman-auto-update.timer`

---

## Phase 5: Automate

**Only after Phases 1-4.**

### 5.1 What to Automate

| Manual Process | Automation |
|---|---|
| Deploy Quadlets to hosts | `~/projects/deploy.sh` (idempotent, role-aware) |
| Image rebuild on push | GitHub Actions → GHCR push → `podman-auto-update.timer` pulls |
| Log alerting | journald → external SIEM (out of scope for now) |
| Dependency updates | Renovate / Dependabot |

### 5.2 Automation Traps

- Don't automate what you haven't deleted
- Don't automate what you haven't simplified
- Every automation = maintenance burden
- A `make <svc> start` wrapper is fake automation — it adds a layer to debug without saving time

---

## Execution Plan

**Do not skip phases. Do not parallelize.**

| Day | Focus |
|-----|-------|
| 1 | Phase 1: inventory everything, attach owners, classify make targets |
| 2 | Phase 2: delete aggressively (track in log), purge `supervisor/` dirs and `make <svc>` wrappers |
| 3 | Phase 2: continue deleting, note 10% add-backs |
| 4 | Phase 3: simplify what survived (config layering, secret naming) |
| 5 | Phase 3: optimize hot paths (aliases, `deploy.sh`, autoupdate timer) |
| 6+ | Phase 4-5: only if 1-3 are solid |

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
│  TOOLING PER LAYER:                             │
│  • Dev/test     →  uv run                       │
│  • Build/E2E    →  podman build / run           │
│  • Ops          →  systemctl --user             │
│  • Logs         →  journalctl --user            │
│  • Atomic ops   →  make <atomic-target>         │
├─────────────────────────────────────────────────┤
│  COMMON MISTAKES:                               │
│  × Automate before deleting                     │
│  × Optimize a process that shouldn't exist      │
│  × make-wrap a single systemctl command         │
│  × Skip questioning smart people's requirements │
└─────────────────────────────────────────────────┘
```

---

**Sources:** Isaacson's Musk biography via Corporate Rebels blog (2023-11-12)
