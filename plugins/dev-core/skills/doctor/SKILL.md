---
name: doctor
description: 'Health check — verify dev-core config, GitHub project, labels, workflows, branch protection. Triggers: "doctor" | "health check" | "check setup" | "verify config".'
version: 0.4.0
allowed-tools: Bash
---

# Doctor

Run the doctor CLI and display the report. Then run stack.yml health checks.

## Instructions

### Phase 1 — dev-core health check

1. Run: `bun ${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts`
2. Display the output directly — it is pre-formatted.
3. If exit code is non-zero, suggest: "Run `/init` to fix missing items."
4. For JSON output: `bun ${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts --json`

### Phase 2 — Stack configuration health check

Severity guide: ❌ = blocking error (exit 1), ⚠️ = warning (optional / contextual), ✅ = pass, ⏭ = skipped.

**File presence:**
- `.claude/stack.yml` exists → ✅ | ❌ "Run `/init` to create it"
- If stack.yml is missing, skip all remaining Phase 2 checks and show ⏭ for each.
- `.claude/stack.yml.example` exists → ✅ | ⚠️ "Consider committing stack.yml.example as a reference"

**Schema:**
- `schema_version` field is present in stack.yml → ✅ | ⚠️ "Add `schema_version: \"1.0\"` to stack.yml"
- Key fields present: `commands.test`, `commands.lint`, `commands.typecheck` → ✅ each | ⚠️ "Missing field: {field_name} — agents may not run correctly"
- Contextual fields (only warn if the section exists but field is blank): `backend.path`, `frontend.path`, `standards.testing`, `standards.backend`, `standards.frontend` → ✅ | ⚠️ "Missing field: {field_name}"

**CLAUDE.md import:**
- First line of `CLAUDE.md` is `@.claude/stack.yml` → ✅ | ⚠️ "Add `@.claude/stack.yml` as the first line of CLAUDE.md so agents pick up your stack config"

**Standards docs exist on disk:**
- For each path in `standards.*`, check the file/directory exists → ✅ | ⚠️ "standards.{key} path not found: {path}"

**Artifact directories:**
- For each path in `artifacts.*`, check the directory exists → ✅ | ⚠️ "artifacts.{key} directory not found: {path}"

**Security:**
- `.claude/stack.yml` is in `.gitignore` → ✅ | ❌ "Add `.claude/stack.yml` to .gitignore (it may contain local paths)"

**Hooks formatter match:**
- If `build.formatter_fix_cmd` in stack.yml contains `biome`, confirm `hooks.json` PostToolUse runs `format.js` → ✅ | ⚠️ "Hooks formatter may not match stack.yml build.formatter_fix_cmd"

**VS Code MDX preview:**
- Only check if `.mdx` files exist in the project (`find . -name "*.mdx" -not -path "*/node_modules/*" | head -1`) or `docs.format: mdx` in stack.yml.
- `.vscode/settings.json` contains `"*.mdx": "markdown"` under `files.associations` → ✅ | ⚠️ "Run `/init` to add MDX preview support in VS Code"
- If no `.mdx` files found → ⏭ skip silently.

Print a final summary:
```
Stack config: N checks passed, M warnings, K errors
```

Only suggest "Run `/init` to fix missing items." if there are ❌ errors.

### Phase 3 — Workspace health check

Verify the multi-project workspace config that powers the multi-tab dashboard.

Run a single check using the canonical workspace helpers:
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

Parse the JSON output and display:
- **workspace.json exists** → ✅ `found at <path>` | ⚠️ `not found — run /init to register this project` (skip remaining checks if missing)
- **Current repo registered** (uses `GITHUB_REPO` env var) → ✅ `<repo> registered` | ⚠️ `current repo not in workspace — run /init to register`
- **projectId format valid** → ✅ all valid | ⚠️ `invalid projectId for <repo> (expected PVT_...)` for each in `invalidIds`
- **Project count:** display `N project(s) registered: <label1>, <label2>, ...`

**Unregistered projects scan:**

```bash
SEARCH_DIRS="$(dirname $PWD) $HOME/projects"
for dir in $SEARCH_DIRS; do
  find "$dir" -maxdepth 3 -name ".env" 2>/dev/null \
    | xargs grep -l "^GITHUB_REPO=" 2>/dev/null
done | sort -u
```

For each found `.env`, extract `GITHUB_REPO` and check if it's already in workspace.json. Collect those that are not (excluding the current repo, already checked above).

- **No unregistered candidates:** ✅ `all local dev-core projects are registered`
- **Unregistered found:** ⚠️ `N project(s) with dev-core config not in workspace: <repo-a>, <repo-b> — run /init to bulk-register`

Print summary line:
```
Workspace: N projects registered  (or: not found)
```

$ARGUMENTS
