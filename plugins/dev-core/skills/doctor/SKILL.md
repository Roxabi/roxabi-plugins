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

Print a final summary:
```
Stack config: N checks passed, M warnings, K errors
```

Only suggest "Run `/init` to fix missing items." if there are ❌ errors.

### Phase 3 — Workspace health check

Verify the multi-project workspace config that powers the multi-tab dashboard.

1. **Locate workspace file:**
   ```bash
   WS_PATH="${HOME}/.roxabi-vault/workspace.json"
   [ -f "$WS_PATH" ] || WS_PATH="${HOME}/.config/roxabi/workspace.json"
   [ -f "$WS_PATH" ] && echo "found:$WS_PATH" || echo "missing"
   ```

2. **workspace.json exists** → ✅ `found at <WS_PATH>` | ⚠️ `not found — run /init to register this project`
   - If missing, mark remaining checks ⏭ and skip to summary.

3. **Current repo registered:**
   ```bash
   CURRENT_REPO=$(git remote get-url origin 2>/dev/null | sed 's|.*github.com[:/]\(.*\)\.git|\1|;s|.*github.com[:/]\(.*\)|\1|')
   python3 -c "
   import json
   ws = json.load(open('$WS_PATH'))
   repos = [p['repo'] for p in ws.get('projects', [])]
   print('registered' if '$CURRENT_REPO' in repos else 'missing')
   "
   ```
   → ✅ `<repo> registered` | ⚠️ `current repo not in workspace — run /init to register`

4. **projectId format valid:** for each entry, check `projectId` starts with `PVT_` → ✅ | ⚠️ `invalid projectId for <repo> (expected PVT_...)`

5. **Project count:** display `N project(s) registered: <label1>, <label2>, ...`

Print summary line:
```
Workspace: N projects registered  (or: not found)
```

$ARGUMENTS
