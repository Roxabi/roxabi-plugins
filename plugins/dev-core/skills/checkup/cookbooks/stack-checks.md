# Cookbook: stack configuration health check

### Phase 2 — Stack configuration health check

Run all checks. Collect fixable items. Apply fixes at end (Phase 2 Fix).

**File presence checks:**

| Check | ✅ | Fail |
|-------|----|----|
| δ ∃ | "dev-core.yml found (primary config)" | ⚠️ "missing — config from .env fallback. Run `/init`" |
| σ ∃ | ✅ | ❌ "stack.yml missing" |
| `.claude/stack.yml.example` ∃ | ✅ | ⚠️ "stack.yml.example missing" |

σ missing → Ask: **Set up now** (recommended) | **Continue with warnings** (stack checks → ⏭).
Set up → O_stackSetup { `cp "${Φ}/stack.yml.example" .claude/stack.yml`; Ask ∀ critical field (Runtime, Backend path, Frontend path, Test command); write values; prepend @import to CLAUDE.md if missing; ¬example → copy; D✅("stack.yml — fill remaining fields; commit alongside code") }. Continue checks against new file.

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

**Release automation:** Only check if `release-please-config.json` ∃ ∨ `release.config.cjs` ∃.
- `release-please-config.json` ∃ → also require `.github/workflows/release-please.yml` ∃ → ✅ | ⚠️ "Release Please config present but no workflow — config alone is a no-op. Run `/release-setup` or copy the workflow template from the cookbook." (auto-fixable)
- `release.config.cjs` ∃ → semantic-release; `package.json` `scripts.release = "semantic-release"` → ✅ | ⚠️.
- Neither → ⏭ (release automation not configured).

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
| `dev-core.yml not in .gitignore` | ensureGitignore(`.claude/dev-core.yml`) |
| `dev-core.yml missing` | Run `/init` |
| `artifacts.* dir missing` | `mkdir -p {path}` ∀ missing |
| `hooks.tool not set` | Append `hooks:\n  tool: auto` to σ |
| `lefthook config missing` | Write `lefthook.yml` with lint+typecheck; `bunx lefthook install` |
| `lefthook not activated` | `bunx lefthook install` |
| `pre-commit config missing` | Write `.pre-commit-config.yaml`; install hooks |
| `pre-commit not activated` | `uv run pre-commit install` |
| `VS Code MDX preview missing` | Merge `"*.mdx": "markdown"` into `.vscode/settings.json` |
| `release-please workflow missing` | `mkdir -p .github/workflows`; write the workflow template from the release-setup cookbook (Release Please block, step 4) |
| `ENABLE_LSP_TOOL not set` | `echo 'ENABLE_LSP_TOOL=1' >> .env && grep -q '^ENABLE_LSP_TOOL=' .env.example 2>/dev/null \|\| echo 'ENABLE_LSP_TOOL=1' >> .env.example` |
| `LSP server not installed` | TS→ bun: `bun add -d typescript-language-server typescript` / pnpm: `pnpm add -D typescript-language-server typescript` / npm: `npm install --save-dev typescript-language-server typescript` / yarn: `yarn add --dev typescript-language-server typescript`. Python→`uv tool install pyright`. Rust→`rustup component add rust-analyzer`. Go→`go install golang.org/x/tools/gopls@latest` |
| `LSP plugin not installed` | Ask: **Global** | **Project** | **Skip**. Global→`claude plugin install <plugin-name>`. Project→`claude plugin install <plugin-name> --scope project` |
| `tools/licenseChecker.ts missing` | `Φ=$(dirname "$(dirname "${CLAUDE_PLUGIN_ROOT}")") && mkdir -p tools && cp "${Φ}/tools/licenseChecker.ts" tools/licenseChecker.ts` |
| `.license-policy.json missing` (JS) | `Φ=$(dirname "$(dirname "${CLAUDE_PLUGIN_ROOT}")") && cp "${Φ}/tools/license-policy.json.example" .license-policy.json` |
| `docs.path missing` / `docs incomplete` | `bun "${Φ}/skills/init/init.ts" scaffold-docs --format {docs.format} --path {docs.path}` — re-check + display |
| `Fumadocs app missing` | `bun "${Φ}/skills/init/init.ts" scaffold-fumadocs --root {cwd} --docs-path {docs.path}` — re-check + display |
| `Stub docs detected` | Run `/seed-docs` — populates TODOs from CLAUDE.md + codebase analysis |

When `standards.*` paths match scaffold-docs output patterns → offer scaffold-docs instead of manual edit.

Issues requiring user input (blank `commands.*`, missing standards paths) → display exact line to add; ask user to edit. Never silently skip.

After fixes, re-run relevant checks and display updated result.
