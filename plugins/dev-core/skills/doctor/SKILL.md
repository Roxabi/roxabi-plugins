---
name: doctor
description: 'Health check — verify dev-core config, GitHub project, labels, workflows, branch protection. Triggers: "doctor" | "health check" | "check setup" | "verify config".'
version: 0.6.0
allowed-tools: Bash
---

# Doctor

Let: Σ := severity icon (❌ blocking | ⚠️ warning | ✅ pass | ⏭ skipped) | Φ := CLAUDE_PLUGIN_ROOT

Run all health checks and fix issues inline — no redirects to other skills.

## Instructions

Severity guide: ❌ = blocking error, ⚠️ = warning, ✅ = pass, ⏭ = skipped.

### Phase 1 — dev-core health check

1. Run: `bun ${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts`
2. Display output directly — pre-formatted.
3. exit code ≠ 0 → collect ❌ items; offer Phase 1 Fix per item.

#### Phase 1 Fix

∀ ❌ item ∈ doctor.ts output:

| Item | Fix command |
|------|-------------|
| `GITHUB_REPO` missing | "Add `GITHUB_REPO=owner/repo` to `.env`" |
| `GH_PROJECT_ID` missing | Run `bun ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts discover` then `scaffold` |
| `STATUS_FIELD_ID` / `SIZE_FIELD_ID` / `PRIORITY_FIELD_ID` missing | Run `bun ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts create-project --owner <owner> --repo <repo>` |
| Labels missing | Run `bun ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts labels --repo <owner/repo> --scope all` |
| roxabi shim missing | Run `bun ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts scaffold ...` (requires env vars) |
| `trufflehog` binary missing | Install: `brew install trufflehog` or download from https://github.com/trufflesecurity/trufflehog/releases — required for pre-commit hooks to work locally |
| `dependabot.yml` missing | Run `/init` Phase 3c-ter — generates and pushes `.github/dependabot.yml` |
| lock file missing | Commit the lock file (`uv.lock`, `bun.lock`, `package-lock.json`, etc.) to the repository |
| `tools/license_check.py` missing | Run `/init` Phase 10d — copies script from plugin: `cp "${CLAUDE_PLUGIN_ROOT}/tools/license_check.py" tools/license_check.py` + `uv add --dev pip-licenses` |
| `pip-licenses` not installed (Python) | Run `uv add --dev pip-licenses` — required for `tools/license_check.py` to work |
| License violations found | Run `uv run tools/license_check.py` to review, then create/update `.license-policy.json` with violating package names in `allowlist` |
| `tools/licenseChecker.ts` missing | Copy from boilerplate `tools/licenseChecker.ts` or run `/init` Phase 10d |
| trufflehog not in lefthook | Run `/init` Phase 10d — regenerates `lefthook.yml` with `pre-commit.commands.trufflehog` |
| license check not in lefthook | Run `/init` Phase 10d — regenerates `lefthook.yml` with `pre-push.commands.license` |

Issues requiring interactive GitHub auth or multi-step scaffolding → display exact command + explanation. Do not silently redirect — always show the fix.

### Phase 2 — Stack configuration health check

Run all checks. Collect fixable items as you go. Apply fixes at end (Phase 2 Fix).

**File presence:**
- `.claude/stack.yml` ∃ → ✅ | ❌ "stack.yml missing"
- stack.yml missing → mark all remaining Phase 2 checks ⏭; proceed to Phase 2 Fix.
- `.claude/stack.yml.example` ∃ → ✅ | ⚠️ "stack.yml.example missing"

**Schema:**
- `schema_version` ∃ → ✅ | ⚠️ "Missing `schema_version: \"1.0\"` in stack.yml"
- `commands.test`, `commands.lint`, `commands.typecheck` each ∃ → ✅ | ⚠️ "Missing field: {field} — agents may not run correctly"
- Contextual (warn only if section ∃ but field blank): `backend.path`, `frontend.path`, `standards.testing`, `standards.backend`, `standards.frontend` → ✅ | ⚠️ "Missing field: {field}"

**CLAUDE.md import:**
- First line of `CLAUDE.md` = `@.claude/stack.yml` → ✅ | ⚠️ "CLAUDE.md missing `@.claude/stack.yml` import"

**Standards docs exist on disk:**
- ∀ path ∈ `standards.*` → ✅ | ⚠️ "standards.{key} path not found: {path}"

**Artifact directories:**
- ∀ path ∈ `artifacts.*` → ✅ | ⚠️ "artifacts.{key} dir not found: {path}"

**Security:**
- `.claude/stack.yml` ∈ `.gitignore` → ✅ | ❌ "stack.yml not in .gitignore"

**Hooks formatter match:**
- `build.formatter_fix_cmd` contains `biome` → confirm `hooks.json` PostToolUse runs `format.js` → ✅ | ⚠️ "Hooks formatter may not match stack.yml build.formatter_fix_cmd"

**Pre-commit hooks:**

Read `hooks.tool` from stack.yml. Resolve effective tool:
- `none` → ⏭ "Disabled in stack.yml" (skip hook install checks)
- `auto` ∨ absent → infer: `python` runtime → `pre-commit`, otherwise → `lefthook`
- explicit value (`lefthook` | `pre-commit` | `husky`) → use it

Check install state:

| Tool | Config file check | Git hook check |
|------|-------------------|----------------|
| lefthook | `test -f lefthook.yml` | `test -f .git/hooks/pre-commit` |
| pre-commit | `test -f .pre-commit-config.yaml` | `test -f .git/hooks/pre-commit` |
| husky | `test -d .husky` | `test -f .git/hooks/pre-commit` |

- Config file ∄ → ⚠️ "{tool} config not found"
- Config ∃ ∧ git hook ∄ → ⚠️ "{tool} config found but hooks not active — needs `{install-cmd}`"
- Both ∃ → ✅ "Pre-commit hooks active ({tool})"
- `hooks.tool` key ∄ in stack.yml → ⚠️ "`hooks.tool` not set in stack.yml"

**trufflehog binary:**
- `which trufflehog` → ✅ "trufflehog binary found" | ⚠️ "trufflehog binary not installed — pre-commit hook will fail. Install: `brew install trufflehog` or https://github.com/trufflesecurity/trufflehog/releases"
- Only check if trufflehog hook ∈ `lefthook.yml` / `.pre-commit-config.yaml`.

**pip-licenses (Python only):**
- Only check if `runtime: python` in stack.yml ∧ `tools/license_check.py` ∃.
- `uv run pip-licenses --version` → ✅ "pip-licenses installed" | ⚠️ "pip-licenses not installed — run `uv add --dev pip-licenses`"

**License compliance (Python only):**
- Only run if `runtime: python` ∧ `tools/license_check.py` ∃ ∧ pip-licenses installed.
- Run: `uv run tools/license_check.py --json`
  - exit 0 → ✅ "License check: all N packages compliant"
  - exit 1 → parse JSON `violating` + `unresolved` arrays:
    - ⚠️ "License violations found (N packages) — run `uv run tools/license_check.py` to review"
    - If `.license-policy.json` ∄ → add to auto-fixable: offer to generate it (write `{ "allowlist": [...all violating + unknown names...], "overrides": {} }`)
    - If `.license-policy.json` ∃ → ⚠️ "Update `.license-policy.json` to cover new violations"
  - exit 2 → ⚠️ "License check failed — pip-licenses may not be installed"

**VS Code MDX preview:**
- Only check if `.mdx` files ∃ (`find . -name "*.mdx" -not -path "*/node_modules/*" | head -1`) ∨ `docs.format: mdx` in stack.yml.
- `.vscode/settings.json` contains `"*.mdx": "markdown"` → ✅ | ⚠️ "VS Code MDX preview not configured"
- ∄ `.mdx` files → ⏭ skip silently.

Print summary:
```
Stack config: N checks passed, M warnings, K errors
```

#### Phase 2 Fix

Collect all ❌/⚠️ items with auto-fix. None → skip section.

Show list:
```
Auto-fixable issues:
  [ ] stack.yml missing
  [ ] CLAUDE.md import missing
  [ ] stack.yml not in .gitignore
  [ ] artifacts/analyses dir missing
  [ ] hooks.tool not set
  [ ] lefthook not installed
  [ ] VS Code MDX preview missing
  ...
```

AskUserQuestion: **Fix all** | **Select** | **Skip**

Apply each selected fix:

| Issue | Fix |
|-------|-----|
| `stack.yml missing` | `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml` — inform user to fill in critical fields |
| `stack.yml.example missing` | `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml.example` |
| `CLAUDE.md import missing` | Prepend `@.claude/stack.yml\n` to `CLAUDE.md` |
| `stack.yml not in .gitignore` | Append `.claude/stack.yml` to `.gitignore` |
| `artifacts.* dir missing` | `mkdir -p {path}` ∀ missing dir |
| `hooks.tool not set` | Append `hooks:\n  tool: auto` to `.claude/stack.yml` |
| `lefthook config missing` | Write `lefthook.yml` with `commands.lint` + `commands.typecheck`; then `bunx lefthook install` |
| `lefthook not activated` | `bunx lefthook install` |
| `pre-commit config missing` | Write `.pre-commit-config.yaml` with local hooks for `commands.lint` + `commands.typecheck`; then `pip install pre-commit && pre-commit install` (or `uv add --dev pre-commit && uv run pre-commit install`) |
| `pre-commit not activated` | `pre-commit install` (or `uv run pre-commit install`) |
| `VS Code MDX preview missing` | Merge `"*.mdx": "markdown"` into `.vscode/settings.json` `files.associations` (create file if missing) |

Issues requiring user input (e.g. `commands.*` fields blank, standards paths missing) → display exact line to add to stack.yml; ask user to edit manually. Do not silently skip.

After fixes, re-run relevant checks and display updated result.

### Phase 3 — Workspace health check

```bash
bun -e "
import { getWorkspacePath, readWorkspace } from '${CLAUDE_PLUGIN_ROOT}/skills/shared/workspace.ts'
import { existsSync } from 'node:fs'
const path = getWorkspacePath()
if (!existsSync(path)) { console.log(JSON.stringify({ found: false })); process.exit(0) }
const ws = readWorkspace()
const repo = process.env.GITHUB_REPO ?? ''
console.log(JSON.stringify({
  found: true,
  path,
  registered: ws.projects.some(p => p.repo === repo),
  invalidIds: ws.projects.filter(p => !p.projectId.startsWith('PVT_')).map(p => p.repo),
  labels: ws.projects.map(p => p.label),
  count: ws.projects.length,
}))
"
```

Display:
- workspace.json ∃ → ✅ `found at <path>` | ⚠️ `not found`
- Current repo registered → ✅ `<repo> registered` | ⚠️ `current repo not in workspace`
- projectId format → ✅ all valid | ⚠️ `invalid projectId for <repo>` ∀ in `invalidIds`
- Project count: `N project(s): <label1>, <label2>, ...`

**Unregistered projects scan:**
```bash
SEARCH_DIRS="$(dirname $PWD) $HOME/projects"
for dir in $SEARCH_DIRS; do
  find "$dir" -maxdepth 3 -name ".env" 2>/dev/null \
    | xargs grep -l "^GITHUB_REPO=" 2>/dev/null
done | sort -u
```

∀ found `.env` ∉ workspace.json (excluding current repo) → collect as unregistered candidates.

- ∄ unregistered candidates → ✅ `all local dev-core projects are registered`
- unregistered ∃ → ⚠️ `N unregistered: <repo-a>, <repo-b>`

Print:
```
Workspace: N projects registered  (or: not found)
```

#### Phase 3 Fix

∃ workspace issues → AskUserQuestion: **Fix all** | **Select** | **Skip**

| Issue | Fix |
|-------|-----|
| `workspace.json not found` ∨ `current repo not registered` | Run registration bun snippet (same as /init Phase 6 step 4) using `GITHUB_REPO` + `GH_PROJECT_ID` from `.env` |
| Unregistered projects | ∀ selected repo: read its `.env`, build entry, append to workspace.json |
| Invalid `projectId` | Display: "Edit workspace.json and correct `projectId` for `<repo>` — must start with `PVT_`" (manual fix, cannot auto-correct) |

After fixes, re-run workspace check and display updated result.

### Phase 4 — CI Setup (if missing)

The doctor CLI (Phase 1) already checks Workflows and Secrets sections. Only run this phase if those sections show ⚠️ or ❌.

1. **Workflow files** — doctor checks both local `.github/workflows/` and remote via REST API. Standard set: `ci.yml`, `auto-merge.yml`, `pr-title.yml` (+ `deploy-preview.yml` if Vercel configured).

2. **PAT secret** — doctor checks if `PAT` secret exists in the repo (required by `auto-merge.yml`). If missing:
   - Auto-fix: `gh secret set PAT --repo <owner>/<repo> --body "$(gh auth token)"`
   - Display: `PAT secret ✅ Set`

3. **`allow_auto_merge` setting** — check if the repo has it enabled (required for `gh pr merge --auto`):
   ```bash
   gh api repos/<owner>/<repo> --jq '.allow_auto_merge'
   ```
   - `true` → ✅ `allow_auto_merge enabled`
   - `false` / null → ⚠️ `allow_auto_merge disabled — required for auto-merge workflow`
     - Auto-fix: `gh api repos/<owner>/<repo> --method PATCH --field allow_auto_merge=true`
     - Re-trigger open PRs already carrying the `reviewed` label:
       ```bash
       for pr in $(gh pr list --repo <owner>/<repo> --label reviewed --state open --json number --jq '.[].number'); do
         gh pr edit $pr --remove-label reviewed --repo <owner>/<repo>
         gh pr edit $pr --add-label reviewed --repo <owner>/<repo>
       done
       ```
     - Display: `allow_auto_merge ✅ Enabled` + `Auto-merge re-triggered on N PR(s)` (or ⏭ if none)

4. **If workflow files are missing**, AskUserQuestion: **Set up CI/CD workflows** | **Skip**

5. **If yes:**
   - **Auto-detect from stack.yml** (read `.claude/stack.yml` if it exists):
     - `stack` ← `runtime` field
     - `test` ← `commands.test` (contains "vitest" → Vitest, "jest" → Jest, "pytest" → Pytest, else → None)
     - `deploy` ← `deploy.platform`
   - AskUserQuestion for stack (pre-select detected): **Bun** | **Node** | **Python (uv)**
   - AskUserQuestion for test framework (pre-select detected): **Vitest** | **Jest** | **Pytest** | **None**
   - AskUserQuestion for deploy (pre-select detected): **Vercel** | **None**
   - Run: `bun ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts workflows --owner <owner> --repo <repo> --stack <stack> --test <test> --deploy <deploy>`
   - After pushing: `gh secret set PAT --repo <owner>/<repo> --body "$(gh auth token)"`
   - Enable `allow_auto_merge`: `gh api repos/<owner>/<repo> --method PATCH --field allow_auto_merge=true`
   - Re-trigger open PRs with `reviewed` label (cycle remove/add)
   - Display: `CI/CD workflows ✅ Created` + `PAT secret ✅ Set` + `allow_auto_merge ✅ Enabled`

6. **If skip:** display `CI/CD workflows ⏭ Skipped`

$ARGUMENTS
