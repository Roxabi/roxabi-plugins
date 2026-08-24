# Cookbook: infrastructure checks

### Phase 3 — Workspace health check

```bash
bun -e "
import { getWorkspacePath, readWorkspace } from '${CLAUDE_PLUGIN_ROOT}/skills/shared/adapters/workspace-helpers.ts'
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

Display: workspace ∃ → ✅ `found at <path>` | ⚠️ `not found`. Repo registered → ✅ | ⚠️. projectId format → ✅ all valid | ⚠️ per invalid. Count: `N project(s): <labels>`.

Unregistered scan:
```bash
SEARCH_DIRS="$(dirname $PWD) $HOME/projects"
for dir in $SEARCH_DIRS; do
  find "$dir" -maxdepth 3 \( -path "*/.claude/dev-core.yml" -o -name ".env" \) 2>/dev/null
done | sort -u
```

∀ found config ∉ workspace (excl. current) → collect. ∄ → ✅ "all registered". ∃ → ⚠️ "N unregistered: <repos>".

Print: `Workspace: N projects registered  (or: not found)`

#### Phase 3 Fix

∃ issues → Ask: **Fix all** | **Select** | **Skip**

| Issue | Fix |
|-------|-----|
| workspace ∄ ∨ repo not registered | Run registration snippet (≡ /init Phase 6 step 4) using config from δ or `.env` |
| Unregistered projects | ∀ selected: read config, build entry, append to workspace.json |
| Invalid `projectId` | Display: edit workspace.json — must start with `PVT_` (manual fix) |

After fixes, re-run + display updated result.

### Phase 4 — CI Setup (if missing)

Only run if Phase 1 doctor shows ⚠️/❌ for Workflows or Secrets.

1. **Workflows** — doctor checks local `.github/workflows/` + remote REST. Standard: `ci.yml`, `secret-scan.yml`, `dependabot-automerge.yml`, `pr-title.yml`, `context-lint.yml`, merge workflow (`auto-merge.yml` or `merge-on-green.yml`), (+ deploy workflow if configured).

2. **App token** — missing `ROXABI_CI_APP_PRIVATE_KEY` / `ROXABI_CI_APP_ID` → provision per `${CLAUDE_PLUGIN_ROOT}/skills/ci-setup/cookbooks/github-app.md`. D✅("roxabi-ci App credentials").

3. **`allow_auto_merge`** (auto-merge repos only — skip for merge-on-green):
   ```bash
   gh api repos/<owner>/<repo> --jq '.allow_auto_merge'
   ```
   `true` → ✅. `false`/null → ⚠️. Fix: `gh api repos/<owner>/<repo> --method PATCH --field allow_auto_merge=true`. Re-trigger `reviewed` PRs:
   ```bash
   for pr in $(gh pr list --repo <owner>/<repo> --label reviewed --state open --json number --jq '.[].number'); do
     gh pr edit $pr --remove-label reviewed --repo <owner>/<repo>
     gh pr edit $pr --add-label reviewed --repo <owner>/<repo>
   done
   ```
   D: `allow_auto_merge ✅ Enabled` + `Auto-merge re-triggered on N PR(s)` (or ⏭).

4. ∃ missing workflows → Ask: **Set up CI/CD** | **Skip**.

5. yes:
   - Auto-detect from σ (see workflows.md Phase 1 step 3).
   - Ask stack / test / deploy / merge strategy (see workflows.md).
   - `bun $I_TS workflows --owner <owner> --repo <repo> --stack <stack> --test <test> --deploy <deploy> --merge <strategy> --lint <bool> --typecheck <bool> --e2e <playwright|none>`
   - Provision App token + enable auto_merge when using auto-merge.
   - D: `CI/CD ✅ Created` + `roxabi-ci App ✅` + `allow_auto_merge ✅` (if applicable).

6. skip → D⏭("CI/CD workflows").

### Phase 5 — CI Permissions check

Runs automatically. Scans `.github/workflows/` for private-repo footgun:

> Job-level `permissions:` block **overrides** workflow-level entirely. Missing `contents: read` → `actions/checkout` fails with `Repository not found` on private repos.

∀ `.yml`/`.yaml` in `.github/workflows/`:
1. Find job-level `permissions:` blocks (4-space indent).
2. `permissions: read-all` / `write-all` → ✅.
3. Mapping without `contents:` AND job has `actions/checkout` → flag.

Severity: private repo → ❌ | public → ⚠️.

Fix (shown inline):
```yaml
permissions:
  contents: read   # ← add this
  actions: read
```
