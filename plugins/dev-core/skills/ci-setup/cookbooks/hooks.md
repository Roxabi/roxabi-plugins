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
⚠️  stack.yml specifies <tool> but <other-tool> config found. Run /R-ci-setup --force to reconfigure.
```
Then skip Phase 2 (don't clobber existing setup without --force).

Cases (for the resolved tool):
- configFile ∃ + hooksInstalled=yes + ¬F → D("Pre-commit hooks", "✅ Already configured"), jump to **2e** (principal freeze offer).
- configFile ∃ + hooksInstalled=no + ¬F → config exists but hooks not installed → skip to **2d-install-only** (run install without regenerating config).
- configFile ∃ + F → present choice: **Overwrite** (regenerate from stack.yml) | **Skip** (keep existing). Skip → D⏭("Pre-commit hooks"), jump to **2e**.
- configFile ∄ → proceed to 2c (full setup).

### 2c — Offer setup

Ask: **Set up `<tool>`** (catches lint/format before push) | **Skip**.

### 2d — Install

Let: lintCmd := stackVal(`commands.lint`) (default `bun run lint`), tchkCmd := stackVal(`commands.typecheck`) (default `bun run typecheck`).

**lefthook:**
a. Detect license cmd: Python → `uv run tools/license_check.py` | JS → `bun tools/licenseChecker.ts`.
b. **Seed TruffleHog scripts** (if missing — same as scanning Phase 1b):
   ```bash
   test -f scripts/trufflehog-check.sh || bun $I_TS seed-trufflehog
   test -f scripts/trufflehog-check.sh || echo "WARN: seed trufflehog failed — install dev-core + re-run"
   ```
c. Install lefthook (branch on `{package_manager}`):
   - `bun`: `bun add -d lefthook`
   - `pnpm`: `pnpm add -D lefthook`
   - `npm`: `npm install --save-dev lefthook`
   - `yarn`: `yarn add --dev lefthook`
   - `python` runtime: Lefthook is a Go binary — check `which lefthook`; missing → display `brew install lefthook` / `go install github.com/evilmartians/lefthook@latest` and continue without installing
d. Write `lefthook.yml` (trufflehog **inside** `commands:`):
   ```yaml
   pre-commit:
     commands:
       principal-freeze:
         run: bash scripts/check-principal-branch.sh
       lint:
         run: <commands.lint>
       typecheck:
         run: <commands.typecheck>
       trufflehog:
         run: bash scripts/trufflehog-check.sh

   pre-push:
     commands:
       principal-freeze:
         run: bash scripts/check-principal-branch.sh
       trufflehog:
         run: bash scripts/trufflehog-check.sh
       license:
         run: <license-cmd>
   ```
e. Seed principal freeze script (`scripts/check-principal-branch.sh`):
   ```bash
   bun $I_TS seed-principal-freeze
   test -f scripts/check-principal-branch.sh || echo "WARN: seed principal-freeze failed — install dev-core + re-run /R-ci-setup"
   ```
f. `bunx lefthook install`
g. Copy license tools (JS/bun only — after lefthook install):
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
         - id: principal-freeze
           name: principal freeze
           entry: bash scripts/check-principal-branch.sh
           language: system
           pass_filenames: false
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
           entry: bash scripts/trufflehog-check.sh
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

g. Ensure TruffleHog scripts exist (idempotent seed if Phase 1b skipped):
   ```bash
   test -f scripts/trufflehog-check.sh && test -f scripts/trufflehog-exclude-paths.txt \
     || bun $I_TS seed-trufflehog
   ```

h. Ensure principal freeze script exists (idempotent):
   ```bash
   test -f scripts/check-principal-branch.sh || bun $I_TS seed-principal-freeze
   ```

i. Check trufflehog binary:
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

j. Run license check + offer policy generation:
   - JS: `bun tools/licenseChecker.ts --json 2>/dev/null`
   - Python: `uv run tools/license_check.py --json 2>/dev/null`
   - exit 0 → D("License check", "✅ All packages compliant").
   - exit 1 → parse violations, display list, Ask: **Generate .license-policy.json** | **Skip**.
     - yes → write `.license-policy.json` with violating names in `allowlist`. D("License policy", "✅ .license-policy.json created (N packages) — review before production").
     - skip → D("License policy", "⏭ Skipped — first push will fail").
   - exit 2 (Python, pip-licenses missing) → D("License check", "⏭ pip-licenses not installed — run `uv add --dev pip-licenses`").

k. D("Pre-commit hooks", "✅ {tool} installed (principal-freeze + lint + typecheck + trufflehog on commit/push, license on push)").

Then run **2e**.

### 2e — Principal freeze (offer, lefthook or pre-commit)

Gate: lefthook refuses `git commit` / `git push` **with matching staged files** when **this** worktree is the principal checkout and HEAD ∉ `{staging, main, master}`. Feature worktrees are a no-op. Hatch (not printed in deny text): `DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1`.

lefthook 2.1.10 skips `git commit --allow-empty` ("no matching staged files") — **named residual**, not a miss. Does **not** block `git switch` (Git has no pre-checkout). Law = lefthook bind+run, not a plugin PreToolUse hook.

1. Detect (not grep/includes of `check-principal-branch.sh`):
   ```bash
   bun $I_TS seed-principal-freeze --check
   ```
   Persist iff JSON `persist: true` (script canonical bytes **and** lefthook binds the script on **pre-commit** and **pre-push**, or pre-commit framework equivalent). Comment / stub / one hook only = not persist.
2. `persist: true` → D("Principal freeze", "✅ Already configured").
3. No `lefthook.yml` / `.lefthook.yml` / `.pre-commit-config.yaml` → D⏭("Principal freeze — no hook runner").
4. Else Ask: **Add principal freeze** (Recommended) — lefthook refuse commit/push **with files** off β | **Skip**.
   - Add → `bun $I_TS seed-principal-freeze` (copies script + patches lefthook / `.pre-commit-config.yaml`). Then re-run `bun $I_TS seed-principal-freeze --check`. `patched: []` is **not** success. Success = `--check` `persist: true` (or `lefthook.yml` actually binds both hooks). Then D✅("Principal freeze").
   - Skip → D⏭("Principal freeze").
