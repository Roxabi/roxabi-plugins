---
name: doctor
description: 'Health check — verify dev-core config, GitHub project, labels, workflows, branch protection. Triggers: "doctor" | "health check" | "check setup" | "verify config".'
version: 0.7.0
allowed-tools: Bash, ToolSearch, AskUserQuestion
---

# Doctor

Let:
  Σ := severity icon (❌ blocking | ⚠️ warning | ✅ pass | ⏭ skipped)
  Φ := CLAUDE_PLUGIN_ROOT
  σ := `.claude/stack.yml`
  δ := `.claude/dev-core.yml`
  I_TS := `${Φ}/skills/init/init.ts`
  D(label, result) := Display: `{label} {result}`
  Ask(opts) := AskUserQuestion with given options
  chk(cond, pass, fail) := cond → ✅ pass | fail
  stackVal(key) := value read from σ
  ensureGitignore(entry) := append entry to .gitignore if missing

Run all health checks and fix issues inline — no redirects to other skills.

Severity guide: ❌ = blocking error, ⚠️ = warning, ✅ = pass, ⏭ = skipped.

### Phase 1 — dev-core health check

1. Run: `bun ${CLAUDE_PLUGIN_ROOT}/skills/doctor/doctor.ts`
2. Display output directly — pre-formatted.
3. exit ≠ 0 → collect ❌ items; offer Phase 1 Fix per item.

#### Phase 1 Fix

∀ ❌ item, apply matching fix:

| Item | Fix |
|------|-----|
| `GITHUB_REPO` missing | Add `github_repo: owner/repo` to δ (or `GITHUB_REPO=owner/repo` to `.env` fallback) |
| `GH_PROJECT_ID` missing | Run `bun $I_TS discover` then `scaffold` — writes δ |
| `STATUS_FIELD_ID`/`SIZE_FIELD_ID`/`PRIORITY_FIELD_ID` missing | Run `bun $I_TS create-project --owner <owner> --repo <repo>` — writes field IDs to δ |
| Labels missing | `bun $I_TS labels --repo <owner/repo> --scope all` |
| roxabi shim missing | `bun $I_TS scaffold ...` (requires env vars) |
| `trufflehog` binary missing | `brew install trufflehog` or https://github.com/trufflesecurity/trufflehog/releases |
| `dependabot.yml` missing | Run `/init` Phase 3c-ter |
| lock file missing | Commit lock file (`uv.lock`, `bun.lock`, `package-lock.json`, etc.) |
| `tools/license_check.py` missing | `cp "${Φ}/tools/license_check.py" tools/license_check.py` + `uv add --dev pip-licenses` |
| `pip-licenses` not installed | `uv add --dev pip-licenses` |
| License violations | Run `uv run tools/license_check.py`, create/update `.license-policy.json` |
| `tools/licenseChecker.ts` missing | Run `/init` Phase 10d |
| trufflehog not in lefthook | Run `/init` Phase 10d — regenerates `lefthook.yml` |
| license check not in lefthook | Run `/init` Phase 10d — regenerates `lefthook.yml` |
| `PR_Main` ruleset missing | `bun $I_TS protect-branches --repo <owner/repo>` |
| `PR_Main` missing `merge` method | Update ruleset via `gh api repos/:owner/:repo/rulesets/<id> --method PUT` with `allowed_merge_methods: ["squash","rebase","merge"]` — merge needed for promotion PRs |

Issues requiring interactive auth / multi-step scaffolding → display exact command + explanation. Never silently redirect.

### Phase 2 — Stack configuration health check

Run all checks. Collect fixable items. Apply fixes at end (Phase 2 Fix).

**File presence checks:**

| Check | ✅ | Fail |
|-------|----|----|
| δ ∃ | "dev-core.yml found (primary config)" | ⚠️ "missing — config from .env fallback. Run `/init`" |
| σ ∃ | ✅ | ❌ "stack.yml missing" |
| `.claude/stack.yml.example` ∃ | ✅ | ⚠️ "stack.yml.example missing" |

σ missing → Ask: **Set up now** (recommended) | **Continue with warnings** (stack checks → ⏭).
Set up → O_stackSetup { `cp "${Φ}/stack.yml.example" .claude/stack.yml`; Ask ∀ critical field (Runtime, Backend path, Frontend path, Test command); write values; prepend @import to CLAUDE.md if missing; ensureGitignore(`.claude/stack.yml`); ¬example → copy; D✅("stack.yml — fill remaining fields") }. Continue checks against new file.

**Schema:** ∀ field ∈ {`schema_version`, `commands.test`, `commands.lint`, `commands.typecheck`}: chk(∃, ✅, ⚠️ "Missing {field}").
Contextual (warn only if parent section ∃ but field blank): `backend.path`, `frontend.path`, `standards.testing`, `standards.backend`, `standards.frontend`.

**CLAUDE.md import:** first line = `@.claude/stack.yml` → ✅ | ⚠️ "missing @import".

**CLAUDE.md Critical Rules completeness:**

Run: `bun $I_TS scaffold-rules --stack-path .claude/stack.yml --claude-md CLAUDE.md`. Parse JSON → `projectType`, `sections`, `existing`.

- `existing.sectionIds` covers all expected sections for `projectType` → ✅ "Critical Rules complete ({N}/{N} sections for {projectType})"
- partial → ⚠️ "Critical Rules incomplete — missing: {missing section ids}. Run `/init` to scaffold." (auto-fixable)
- ∅ → ⚠️ "Critical Rules not scaffolded. Run `/init` to generate governance rules." (auto-fixable)

Auto-fix for partial/missing: run `/init` Phase 2c (scaffold-rules).

**Standards docs:** ∀ path ∈ `standards.*` → chk(existsOnDisk, ✅, ⚠️ "path not found: {path}").

**Documentation:**
Read `docs.path` from σ. ¬set → D⏭("docs.path not set"), skip doc checks.
- `docs.path` dir ∃ → ✅ | ⚠️ "not found on disk" (auto-fixable).
- ∃ dir → check `architecture/` ∧ `standards/`: both → ✅ | ⚠️ "incomplete — missing: {dirs}" (auto-fixable).
- `docs.framework: fumadocs` → `apps/docs/source.config.ts` ∃ → ✅ | ⚠️ "Fumadocs app missing" (auto-fixable).
- **Stub detection:** ∀ file in `docs.path` (*.md, *.mdx): count files with `TODO:` markers or < 30 lines of real content. N > 0 → ⚠️ "{N} stub docs detected — run `/seed-docs` to populate from CLAUDE.md + codebase". N = 0 → ✅ "Docs populated".

**Artifacts:** ∀ path ∈ `artifacts.*` → chk(∃, ✅, ⚠️ "dir not found: {path}").

**Security:**
- σ ∈ `.gitignore` → ✅ | ❌ "not in .gitignore".
- δ ∈ `.gitignore` → ✅ | ❌ "not in .gitignore (contains project field IDs)".

**Hooks formatter:** `build.formatter_fix_cmd` contains `biome` → confirm `hooks.json` PostToolUse runs `format.js` → ✅ | ⚠️ "formatter mismatch".

**Pre-commit hooks:**
Read `hooks.tool` from σ. Resolve: `none` → ⏭ | `auto`/absent → python→`pre-commit`, else→`lefthook` | explicit → use.

| Tool | Config check | Hook check |
|------|-------------|------------|
| lefthook | `test -f lefthook.yml` | `test -f .git/hooks/pre-commit` |
| pre-commit | `test -f .pre-commit-config.yaml` | `test -f .git/hooks/pre-commit` |
| husky | `test -d .husky` | `test -f .git/hooks/pre-commit` |

Config ∄ → ⚠️. Config ∃ ∧ hook ∄ → ⚠️ "needs `{install-cmd}`". Both ∃ → ✅. `hooks.tool` ∄ in σ → ⚠️.

**trufflehog binary:** Only check if trufflehog hook ∈ config. `which trufflehog` → ✅ | ⚠️ "not installed — `brew install trufflehog`".

**pip-licenses (Python only):** Only if `runtime: python` ∧ `tools/license_check.py` ∃. `uv run pip-licenses --version` → ✅ | ⚠️ "run `uv add --dev pip-licenses`".

**License compliance (Python):** Only if python ∧ script ∃ ∧ pip-licenses installed. `uv run tools/license_check.py --json`:
- exit 0 → ✅ "all N compliant"
- exit 1 → parse `violating`+`unresolved`: ⚠️ "N violations". `.license-policy.json` ∄ → auto-fixable (generate). ∃ → ⚠️ "update policy".
- exit 2 → ⚠️ "pip-licenses may not be installed"

**License checker (JS):** Only if runtime ∈ {bun,node,deno}. `tools/licenseChecker.ts` ∃ → ✅ | ⚠️. `.license-policy.json` ∃ → ✅ | ⚠️.

**License compliance (JS):** Only if JS runtime ∧ checker ∃ ∧ policy ∃. `bun tools/licenseChecker.ts --json`:
- exit 0 → ✅ "all N compliant"
- exit 1 → ⚠️ "N violations". Policy ∄ → auto-fixable. ∃ → ⚠️ "update policy".
- exit 2 → ⚠️ "run checker to debug"

**VS Code MDX preview:** Only if `.mdx` files ∃ ∨ `docs.format: mdx`. `.vscode/settings.json` has `"*.mdx": "markdown"` → ✅ | ⚠️. ∄ .mdx → ⏭.

**LSP support:** `lsp.enabled: false` → ⏭. Else:
- `ENABLE_LSP_TOOL` in .env → ✅ | ⚠️ (auto-fixable).
- Detect binary from `lsp.server`/`runtime` (bun/node/deno→`typescript-language-server`, python→`pyright`, rust→`rust-analyzer`, go→`gopls`). `which <binary>` → ✅ | ⚠️ + install hint (auto-fixable).
- **Claude Code LSP plugin:** detect plugin name (bun/node/deno→`typescript-lsp`, python→`pyright-lsp`, rust/go→skip). `claude plugin list 2>/dev/null | grep -q '<plugin-name>'` → ✅ | ⚠️ "LSP plugin not installed — run `claude plugin install <plugin-name>`" (auto-fixable).

Print summary:
```
Stack config: N checks passed, M warnings, K errors
Docs          ✅ docs/ present, structure complete, docs populated[, Fumadocs ✅]
              ⚠️ docs/ not found on disk — run scaffold-docs to fix
              ⚠️ docs structure incomplete (missing: {dirs}) — run scaffold-docs
              ⚠️ {N} stub docs detected — run /seed-docs to populate
              ⏭ docs.path not set in stack.yml
```
Note: Fumadocs segment appended only when `docs.framework: fumadocs`.

#### Phase 2 Fix

Collect all ❌/⚠️ with auto-fix. None → skip.

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
  [ ] ENABLE_LSP_TOOL not set
  [ ] LSP server not installed
  [ ] LSP plugin not installed
  ...
```

Ask: **Fix all** | **Select** | **Skip**

∀ selected fix:

| Issue | Fix |
|-------|-----|
| `stack.yml missing` | Re-offer O_stackSetup |
| `stack.yml.example missing` | `cp "${Φ}/stack.yml.example" .claude/stack.yml.example` |
| `CLAUDE.md import missing` | Prepend `@.claude/stack.yml\n` to CLAUDE.md |
| `Critical Rules missing/incomplete` | Run `bun $I_TS scaffold-rules`, then append/merge generated markdown into CLAUDE.md (same logic as `/init` Phase 2c) |
| `stack.yml not in .gitignore` | ensureGitignore(`.claude/stack.yml`) |
| `dev-core.yml not in .gitignore` | ensureGitignore(`.claude/dev-core.yml`) |
| `dev-core.yml missing` | Run `/init` |
| `artifacts.* dir missing` | `mkdir -p {path}` ∀ missing |
| `hooks.tool not set` | Append `hooks:\n  tool: auto` to σ |
| `lefthook config missing` | Write `lefthook.yml` with lint+typecheck; `bunx lefthook install` |
| `lefthook not activated` | `bunx lefthook install` |
| `pre-commit config missing` | Write `.pre-commit-config.yaml`; install hooks |
| `pre-commit not activated` | `uv run pre-commit install` |
| `VS Code MDX preview missing` | Merge `"*.mdx": "markdown"` into `.vscode/settings.json` |
| `ENABLE_LSP_TOOL not set` | `echo 'ENABLE_LSP_TOOL=1' >> .env && grep -q '^ENABLE_LSP_TOOL=' .env.example 2>/dev/null \|\| echo 'ENABLE_LSP_TOOL=1' >> .env.example` |
| `LSP server not installed` | TS→`{package_manager} add -d typescript-language-server typescript`, Python→`uv tool install pyright`, Rust→`rustup component add rust-analyzer`, Go→`go install golang.org/x/tools/gopls@latest` |
| `LSP plugin not installed` | Ask: **Global** | **Project** | **Skip**. Global→`claude plugin install <plugin-name>`. Project→`claude plugin install <plugin-name> --scope project` |
| `tools/licenseChecker.ts missing` | `Φ=$(dirname "$(dirname "${CLAUDE_PLUGIN_ROOT}")") && mkdir -p tools && cp "${Φ}/tools/licenseChecker.ts" tools/licenseChecker.ts` |
| `.license-policy.json missing` (JS) | `Φ=$(dirname "$(dirname "${CLAUDE_PLUGIN_ROOT}")") && cp "${Φ}/tools/license-policy.json.example" .license-policy.json` |
| `docs.path missing` / `docs incomplete` | `bun "${Φ}/skills/init/init.ts" scaffold-docs --format {docs.format} --path {docs.path}` — re-check + display |
| `Fumadocs app missing` | `bun "${Φ}/skills/init/init.ts" scaffold-fumadocs --root {cwd} --docs-path {docs.path}` — re-check + display |
| `Stub docs detected` | Run `/seed-docs` — populates TODOs from CLAUDE.md + codebase analysis |

When `standards.*` paths match scaffold-docs output patterns → offer scaffold-docs instead of manual edit.

Issues requiring user input (blank `commands.*`, missing standards paths) → display exact line to add; ask user to edit. Never silently skip.

After fixes, re-run relevant checks and display updated result.

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

1. **Workflows** — doctor checks local `.github/workflows/` + remote REST. Standard: `ci.yml`, `auto-merge.yml`, `pr-title.yml` (+ `deploy-preview.yml` if Vercel).

2. **PAT secret** — missing → `gh secret set PAT --repo <owner>/<repo> --body "$(gh auth token)"`. D✅("PAT secret").

3. **`allow_auto_merge`:**
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
   - Auto-detect from σ: `stack` ← `runtime`, `test` ← `commands.test`, `deploy` ← `deploy.platform`.
   - Ask stack (pre-select): **Bun** | **Node** | **Python (uv)**
   - Ask test (pre-select): **Vitest** | **Jest** | **Pytest** | **None**
   - Ask deploy (pre-select): **Vercel** | **None**
   - `bun $I_TS workflows --owner <owner> --repo <repo> --stack <stack> --test <test> --deploy <deploy>`
   - Set PAT + enable auto_merge + re-trigger PRs.
   - D: `CI/CD ✅ Created` + `PAT ✅` + `allow_auto_merge ✅`.

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

$ARGUMENTS
