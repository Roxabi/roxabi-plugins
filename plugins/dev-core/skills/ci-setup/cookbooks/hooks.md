# Cookbook: Pre-commit Hooks

Let:
  Φ    := CLAUDE_PLUGIN_ROOT
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

## Phase 2 — Pre-commit Hooks (Optional)

### 2a — Resolve tool from stack.yml first

Read `hooks.tool` from σ (stack.yml). σ ∄ → use `auto`.

- `none` → D⏭("Pre-commit hooks — Disabled in stack.yml"), skip Phase 2.
- `auto` ∨ absent → infer from `runtime`: `python` → **pre-commit**, else → **lefthook**.
- explicit (`lefthook`|`pre-commit`|`husky`) → use directly.

Let: tool := resolved tool name.
Let: configFile := tool=`pre-commit` ? `.pre-commit-config.yaml` | tool=`lefthook` ? `lefthook.yml` | tool=`husky` ? `.husky/`.
Let: hooksInstalled := `test -f .git/hooks/pre-commit && echo yes || echo no`.

### 2b — Detect state

Check in parallel:
```bash
test -f lefthook.yml && echo found || echo missing        # lefthook config
test -d .husky && echo found || echo missing              # husky config
test -f .pre-commit-config.yaml && echo found || echo missing  # pre-commit config
test -f .git/hooks/pre-commit && echo yes || echo no      # hooks actually installed
```

Detect mismatch: if a config file for a *different* tool exists (not configFile for resolved tool) → warn:
```
⚠️  stack.yml specifies <tool> but <other-tool> config found. Run /ci-setup --force to reconfigure.
```
Then skip Phase 2 (don't clobber existing setup without --force).

Cases (for the resolved tool):
- configFile ∃ + hooksInstalled=yes + ¬F → D("Pre-commit hooks", "✅ Already configured"), skip Phase 2.
- configFile ∃ + hooksInstalled=no + ¬F → config exists but hooks not installed → skip to **2d-install-only** (run install without regenerating config).
- configFile ∃ + F → → DP(A): **Overwrite** (regenerate from stack.yml) | **Skip** (keep existing). Skip → D⏭("Pre-commit hooks"), stop Phase 2.
- configFile ∄ → proceed to 2c (full setup).

### 2c — Offer setup

Ask: **Set up `<tool>`** (catches lint/format before push) | **Skip**.

### 2d — Install

Let: lintCmd := stackVal(`commands.lint`) (default `bun run lint`), tchkCmd := stackVal(`commands.typecheck`) (default `bun run typecheck`).

**lefthook:**
a. Detect license cmd: Python → `uv run tools/license_check.py` | JS → `bun tools/licenseChecker.ts`.
b. Install lefthook (branch on `{package_manager}`):
   - `bun`: `bun add -d lefthook`
   - `pnpm`: `pnpm add -D lefthook`
   - `npm`: `npm install --save-dev lefthook`
   - `yarn`: `yarn add --dev lefthook`
   - `python` runtime: Lefthook is a Go binary — check `which lefthook`; missing → display `brew install lefthook` / `go install github.com/evilmartians/lefthook@latest` and continue without installing
c. Write `lefthook.yml`:
   ```yaml
   pre-commit:
     commands:
       lint:
         run: <commands.lint>
       typecheck:
         run: <commands.typecheck>

     trufflehog:
       run: trufflehog git file://. --only-verified --fail

   pre-push:
     commands:
       license:
         run: <license-cmd>
   ```
d. `bunx lefthook install`
e. Copy license tools (JS/bun only — after lefthook install):
   ```bash
   [[ "${CLAUDE_PLUGIN_ROOT}" =~ ^/[a-zA-Z0-9/_.-]+$ ]] || { echo "ERROR: invalid CLAUDE_PLUGIN_ROOT"; exit 1; }
   Φ=$(dirname "$(dirname "${CLAUDE_PLUGIN_ROOT}")")
   test -f "${Φ}/tools/licenseChecker.ts" || { echo "ERROR: licenseChecker.ts not found in plugin (path: ${Φ}/tools/)"; exit 1; }
   mkdir -p tools
   cp "${Φ}/tools/licenseChecker.ts" tools/licenseChecker.ts
   # Copy default policy template only if no policy file exists yet
   test -f .license-policy.json || cp "${Φ}/tools/license-policy.json.example" .license-policy.json
   # Gitignore the reports/ output directory
   grep -q 'reports/' .gitignore 2>/dev/null || echo 'reports/' >> .gitignore
   ```
   Add `"license": "bun tools/licenseChecker.ts"` to `package.json` scripts (if not set).
   D✅("License checker — tools/licenseChecker.ts copied").

**pre-commit (Python):**
a. Install: `uv add --dev pre-commit pip-licenses`
b. Copy: `mkdir -p tools && cp "${CLAUDE_PLUGIN_ROOT}/tools/license_check.py" tools/license_check.py`
c. Write `.pre-commit-config.yaml`:
   ```yaml
   repos:
     - repo: local
       hooks:
         - id: lint
           name: lint
           entry: <commands.lint>
           language: system
           pass_filenames: false
         - id: typecheck
           name: typecheck
           entry: <commands.typecheck>
           language: system
           pass_filenames: false
         - id: trufflehog
           name: trufflehog secret scan
           entry: trufflehog git file://. --only-verified --fail
           language: system
           pass_filenames: false
         - id: license
           name: license check
           entry: uv run tools/license_check.py
           language: system
           pass_filenames: false
           stages: [pre-push]
   ```
d. `uv run pre-commit install && uv run pre-commit install --hook-type pre-push`

### 2d-install-only — Re-install hooks (config exists, hooks missing)

Skip config generation. Before running install, check for `core.hooksPath`:
```bash
git config --get core.hooksPath 2>/dev/null || echo ""
```
∃ non-empty value → unset it (pre-commit refuses to install when set, even to the default):
```bash
git config --unset-all core.hooksPath
```
Display: `⚠️  core.hooksPath was set — unset before installing hooks.`

Run only the install step for the resolved tool:
- `lefthook`: `bunx lefthook install` (or `lefthook install` if Go binary)
- `pre-commit`: `uv run pre-commit install && uv run pre-commit install --hook-type pre-push`
- `husky`: `bunx husky`

D("Pre-commit hooks", "✅ Hooks re-installed (config already present)").
Then jump to **Common post-install** below.

**Common post-install ∀ tool:**

f. Check trufflehog binary:
   ```bash
   which trufflehog 2>/dev/null && echo "installed" || echo "missing"
   ```
   missing → display:
   ```
   ⚠️  trufflehog binary not found — pre-commit hook will fail until installed.
       Install options:
         • Homebrew:       brew install trufflehog
         • GitHub release: https://github.com/trufflesecurity/trufflehog/releases
   ```

g. Run license check + offer policy generation:
   - JS: `bun tools/licenseChecker.ts --json 2>/dev/null`
   - Python: `uv run tools/license_check.py --json 2>/dev/null`
   - exit 0 → D("License check", "✅ All packages compliant").
   - exit 1 → parse violations, display list, Ask: **Generate .license-policy.json** | **Skip**.
     - yes → write `.license-policy.json` with violating names in `allowlist`. D("License policy", "✅ .license-policy.json created (N packages) — review before production").
     - skip → D("License policy", "⏭ Skipped — first push will fail").
   - exit 2 (Python, pip-licenses missing) → D("License check", "⏭ pip-licenses not installed — run `uv add --dev pip-licenses`").

h. D("Pre-commit hooks", "✅ {tool} installed (lint + typecheck + trufflehog on commit, license on push)").
