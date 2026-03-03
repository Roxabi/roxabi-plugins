---
name: doctor
description: 'Health check — verify dev-core config, GitHub project, labels, workflows, branch protection. Triggers: "doctor" | "health check" | "check setup" | "verify config".'
version: 0.5.0
allowed-tools: Bash
---

# Doctor

Run all health checks and fix issues inline — no redirects to other skills.

## Instructions

Severity guide: ❌ = blocking error, ⚠️ = warning, ✅ = pass, ⏭ = skipped.

### Phase 1 — dev-core health check

1. Run: `bun ${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts`
2. Display the output directly — it is pre-formatted.
3. If exit code is non-zero, collect the failing items from the output and offer to fix each one below (Phase 1 Fix).

#### Phase 1 Fix

For each ❌ item in the doctor.ts output, map to the fix:

| Item | Fix command |
|------|-------------|
| `GITHUB_REPO` missing | "Add `GITHUB_REPO=owner/repo` to `.env`" |
| `GH_PROJECT_ID` missing | Run `bun ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts discover` then `scaffold` |
| `STATUS_FIELD_ID` / `SIZE_FIELD_ID` / `PRIORITY_FIELD_ID` missing | Run `bun ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts create-project --owner <owner> --repo <repo>` |
| Labels missing | Run `bun ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts labels --repo <owner/repo> --scope all` |
| roxabi shim missing | Run `bun ${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts scaffold ...` (requires env vars) |

For issues requiring interactive GitHub auth or multi-step scaffolding that can't be fixed with a single command, display the exact command to run and explain what it does. Do not silently redirect — always show the fix.

### Phase 2 — Stack configuration health check

Run all checks. Collect fixable items as you go. Apply fixes at the end (Phase 2 Fix).

**File presence:**
- `.claude/stack.yml` exists → ✅ | ❌ "stack.yml missing"
- If stack.yml is missing, mark all remaining Phase 2 checks as ⏭ and proceed to Phase 2 Fix.
- `.claude/stack.yml.example` exists → ✅ | ⚠️ "stack.yml.example missing"

**Schema:**
- `schema_version` present → ✅ | ⚠️ "Missing `schema_version: \"1.0\"` in stack.yml"
- `commands.test`, `commands.lint`, `commands.typecheck` each present → ✅ | ⚠️ "Missing field: {field} — agents may not run correctly"
- Contextual (only warn if section exists but field is blank): `backend.path`, `frontend.path`, `standards.testing`, `standards.backend`, `standards.frontend` → ✅ | ⚠️ "Missing field: {field}"

**CLAUDE.md import:**
- First line of `CLAUDE.md` is `@.claude/stack.yml` → ✅ | ⚠️ "CLAUDE.md missing `@.claude/stack.yml` import"

**Standards docs exist on disk:**
- For each path in `standards.*` → ✅ | ⚠️ "standards.{key} path not found: {path}"

**Artifact directories:**
- For each path in `artifacts.*` → ✅ | ⚠️ "artifacts.{key} dir not found: {path}"

**Security:**
- `.claude/stack.yml` in `.gitignore` → ✅ | ❌ "stack.yml not in .gitignore"

**Hooks formatter match:**
- If `build.formatter_fix_cmd` contains `biome`, confirm `hooks.json` PostToolUse runs `format.js` → ✅ | ⚠️ "Hooks formatter may not match stack.yml build.formatter_fix_cmd"

**Pre-commit hooks:**

Read `hooks.tool` from stack.yml (if present). Resolve effective tool:
- `none` → ⏭ "Disabled in stack.yml" (skip hook install checks)
- `auto` or absent → infer: `python` runtime → `pre-commit`, otherwise → `lefthook`
- explicit value (`lefthook`, `pre-commit`, `husky`) → use it

Then check install state based on effective tool:

| Tool | Config file check | Git hook check |
|------|-------------------|----------------|
| lefthook | `test -f lefthook.yml` | `test -f .git/hooks/pre-commit` |
| pre-commit | `test -f .pre-commit-config.yaml` | `test -f .git/hooks/pre-commit` |
| husky | `test -d .husky` | `test -f .git/hooks/pre-commit` |

- Config file missing → ⚠️ "{tool} config not found"
- Config file present but git hook not installed → ⚠️ "{tool} config found but hooks not active — needs `{install-cmd}`"
- Both present → ✅ "Pre-commit hooks active ({tool})"
- `hooks.tool` key absent from stack.yml → ⚠️ "`hooks.tool` not set in stack.yml"

**VS Code MDX preview:**
- Only check if `.mdx` files exist (`find . -name "*.mdx" -not -path "*/node_modules/*" | head -1`) or `docs.format: mdx` in stack.yml.
- `.vscode/settings.json` contains `"*.mdx": "markdown"` → ✅ | ⚠️ "VS Code MDX preview not configured"
- No `.mdx` files → ⏭ skip silently.

Print summary:
```
Stack config: N checks passed, M warnings, K errors
```

#### Phase 2 Fix

Collect all ❌ / ⚠️ items that have an auto-fix. If none → skip this section.

Show the list:
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
| `stack.yml missing` | `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml` — then inform user to fill in critical fields |
| `stack.yml.example missing` | `cp "${CLAUDE_PLUGIN_ROOT}/stack.yml.example" .claude/stack.yml.example` |
| `CLAUDE.md import missing` | Prepend `@.claude/stack.yml\n` to `CLAUDE.md` |
| `stack.yml not in .gitignore` | Append `.claude/stack.yml` to `.gitignore` |
| `artifacts.* dir missing` | `mkdir -p {path}` for each missing dir |
| `hooks.tool not set` | Append `hooks:\n  tool: auto` to `.claude/stack.yml` |
| `lefthook config missing` | Write `lefthook.yml` with `commands.lint` + `commands.typecheck`, then `bunx lefthook install` |
| `lefthook not activated` | `bunx lefthook install` |
| `pre-commit config missing` | Write `.pre-commit-config.yaml` with local hooks for `commands.lint` + `commands.typecheck`, then `pip install pre-commit && pre-commit install` (or `uv add --dev pre-commit && uv run pre-commit install`) |
| `pre-commit not activated` | `pre-commit install` (or `uv run pre-commit install`) |
| `VS Code MDX preview missing` | Merge `"*.mdx": "markdown"` into `.vscode/settings.json` `files.associations` (create file if missing) |

For issues that require user input (e.g. `commands.*` fields blank, standards paths missing) → display the exact line to add to stack.yml and ask the user to edit the file manually. Do not silently skip.

After applying fixes, re-run the relevant checks and display the updated result.

### Phase 3 — Workspace health check

Run:
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
- **workspace.json found** → ✅ `found at <path>` | ⚠️ `not found`
- **Current repo registered** → ✅ `<repo> registered` | ⚠️ `current repo not in workspace`
- **projectId format** → ✅ all valid | ⚠️ `invalid projectId for <repo>` for each in `invalidIds`
- **Project count:** `N project(s): <label1>, <label2>, ...`

**Unregistered projects scan:**
```bash
SEARCH_DIRS="$(dirname $PWD) $HOME/projects"
for dir in $SEARCH_DIRS; do
  find "$dir" -maxdepth 3 -name ".env" 2>/dev/null \
    | xargs grep -l "^GITHUB_REPO=" 2>/dev/null
done | sort -u
```

For each found `.env` not in workspace.json (excluding current repo) → collect as unregistered candidates.

- No unregistered candidates → ✅ `all local dev-core projects are registered`
- Unregistered found → ⚠️ `N unregistered: <repo-a>, <repo-b>`

Print:
```
Workspace: N projects registered  (or: not found)
```

#### Phase 3 Fix

If any workspace issues → AskUserQuestion: **Fix all** | **Select** | **Skip**

| Issue | Fix |
|-------|-----|
| `workspace.json not found` or `current repo not registered` | Run the registration bun snippet (same as /init Phase 6 step 4) using `GITHUB_REPO` + `GH_PROJECT_ID` from `.env` |
| Unregistered projects | For each selected repo, read its `.env`, build entry, append to workspace.json |
| Invalid `projectId` | Display: "Edit workspace.json and correct `projectId` for `<repo>` — must start with `PVT_`" (manual fix, cannot auto-correct) |

After applying fixes, re-run the workspace check and display updated result.

$ARGUMENTS
