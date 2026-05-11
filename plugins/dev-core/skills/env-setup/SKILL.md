---
name: env-setup
argument-hint: '[--force]'
description: 'Set up local dev environment — stack.yml, CLAUDE.md Critical Rules, docs scaffolding, VS Code MDX, LSP. Triggered by /init or standalone. Triggers: "env setup" | "setup environment" | "configure stack" | "scaffold rules".'
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, ToolSearch
---

# Env Setup

Let:
  I_TS := `${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts`
  Φ    := CLAUDE_PLUGIN_ROOT
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")
  ensureGitignore(entry) := `grep -q '{entry}' .gitignore 2>/dev/null || echo '{entry}' >> .gitignore`

Configure local developer environment: stack config, governance rules, docs stubs, editor settings, LSP.
Runs standalone (`/env-setup`) or called by `/init` as part of full project initialization.

## Phase 1 — Stack Configuration

Set up σ early — later phases read runtime, package manager, commands, deploy platform, hooks tool, docs format.

1. `test -f .claude/stack.yml && echo exists || echo missing`
2. missing → Ask: **Set up stack.yml now** (recommended) | **Skip** (fallback defaults).
3. **Set up** → O_stackSetup:
   - `cp "${Φ}/stack.yml.example" .claude/stack.yml`
   - Ask ∀ critical field: **Runtime** → bun|node|python → `runtime`+`package_manager` | **Backend path** (e.g. `apps/api`, blank=none) | **Frontend path** (e.g. `apps/web`, blank=none) | **Test command** → `commands.test`
   - Write values into σ. Inform: "Fill in remaining fields in σ before running agents."
4. `head -1 CLAUDE.md` → ¬`@.claude/stack.yml` → prepend `@.claude/stack.yml\n`. D✅("@import").
5. ¬`.claude/stack.yml.example` → `cp "${Φ}/stack.yml.example" .claude/stack.yml.example`. D("stack.yml.example", "✅ Created (reference template)").
6. existing → D("stack.yml", "✅ Already exists"), skip.

Note: `.claude/stack.yml` is **committed** (project stack conventions — no secrets). Only `.env` is gitignored by dev-core. `.claude/dev-core.yml` contains only public GitHub Project node IDs and is committed.

### Phase 1b — Global Patterns Injection

Inject plugin-managed always-on behavioral patterns (decision protocol, agent discipline, context discipline, dev process, worktree, parallel execution, git) into `~/.claude/shared/global-patterns.md` (one shared copy) and reference it directly from CLAUDE.md.

1. `mkdir -p ~/.claude/shared/`
2. [F ∨ `¬test -f ~/.claude/shared/global-patterns.md`] → `cp "${Φ}/../shared/references/global-patterns.md" ~/.claude/shared/global-patterns.md`. D✅("~/.claude/shared/global-patterns.md").
   ∃ ∧ ¬F → D("~/.claude/shared/global-patterns.md", "✅ Already present"), skip copy.
3. `grep -q '@~/.claude/shared/global-patterns.md' CLAUDE.md 2>/dev/null` → ∃ → D("@global-patterns", "✅ Already present"), skip.
   ¬∃ → remove `@.claude/dev-core.md` line from CLAUDE.md if present. Prepend `@~/.claude/shared/global-patterns.md\n` (after `@.claude/stack.yml` line if present, otherwise at top). D✅("@~/.claude/shared/global-patterns.md").
4. `test -f .claude/dev-core.md` → `rm .claude/dev-core.md`. Remove `.claude/dev-core.md` from .gitignore if present. D✅("removed .claude/dev-core.md").

Re-run (`--force`): overwrite `~/.claude/shared/global-patterns.md` with latest plugin version.

## Phase 2 — Scaffold CLAUDE.md Critical Rules

Generate governance rules (dev process, decision protocol, git conventions, etc.) from σ values. Sections vary by project type.

σ ∄ → D("Critical Rules", "⏭ Skipped — requires stack.yml"), skip to Phase 3.

1. Run: `bun $I_TS scaffold-rules --stack-path .claude/stack.yml --claude-md CLAUDE.md`
2. Parse JSON → extract `projectType`, `sections`, `markdown`, `existing`.
3. Display:
   ```
   Project type: {projectType}
   Sections to scaffold: {sections.length} ({section ids joined by ", "})
   ```
4. Check `existing.sectionIds`:
   - ∅ existing → Ask: **Scaffold Critical Rules** (append to CLAUDE.md) | **Skip**
   - partial (some present, some missing) → list missing; Ask: **Merge** (append missing only) | **Replace** (rewrite all) | **Skip**
   - all present → D("Critical Rules", "✅ Already complete"), skip.
5. Scaffold/Replace → append or replace `## Critical Rules` block with `markdown`. Preserve content before and after.
6. Merge → ∀ section ∈ generated ∧ section.id ∉ existing.sectionIds → append after last existing Critical Rules heading.
7. D("Critical Rules", "✅ Scaffolded ({sections.length} sections for {projectType})")

## Phase 3 — Documentation Scaffolding (Optional)

1. Read `docs.path` + `docs.format` from σ (defaults: `docs`, `md`).
2. `{docs.path}/standards/` ∃ → D("Docs scaffolding", "✅ Already present"), skip.
3. Ask: **Scaffold standard docs** (architecture/, standards/, guides/ with templates) | **Skip**.
4. yes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-docs --format <docs.format> --path <docs.path>
   ```
5. D("Docs scaffolding", "✅ Created {filesCreated.length} files in {docsPath}/").

### Phase 3b — Fumadocs App Scaffold (Optional)

Run only if `docs.framework: fumadocs` in σ.

1. Ask: **Scaffold Fumadocs app** (`apps/docs/` Next.js + `docs/` content — Mermaid, Shiki, Tailwind v4) | **Skip**
2. yes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-fumadocs --root <cwd> --docs-path <docs.path>
   ```
   D("Fumadocs scaffold", "✅ Created {filesCreated.length} files in apps/docs/ and {docs.path}/"). List files grouped by dir. ∃ warnings → display each with ⚠️.
3. Remind: `bun install` in `apps/docs/`, then `bun dev` for docs server on port 3002.

## Phase 4 — VS Code MDX Preview (Optional)

Run only if `find . -name "*.mdx" -not -path "*/node_modules/*" | head -1` returns result ∨ `docs.format: mdx` in σ.

1. Check `.vscode/settings.json` for `"*.mdx": "markdown"` in `files.associations`.
2. ∃ → D("VS Code MDX preview", "✅ Already configured"), skip.
3. ∄ → Ask: **Add VS Code MDX preview** | **Skip**.
4. yes → ¬file → create `{"files.associations": {"*.mdx": "markdown"}}` | ∃ file → merge key. D✅("VS Code MDX preview").

## Phase 5 — LSP Support (Optional)

Enable `ENABLE_LSP_TOOL` for richer code intelligence in Claude Code sessions.

1. Read `lsp.enabled` from σ. `false` → D⏭("LSP — Disabled in stack.yml"), skip. `true` ∨ absent → continue.
2. `grep -q '^ENABLE_LSP_TOOL=' .env 2>/dev/null && echo "set" || echo "missing"`. set → D("ENABLE_LSP_TOOL", "✅ Already configured"), skip to step 6.
3. Ask: **Enable LSP** (`ENABLE_LSP_TOOL=1` + language server) | **Skip**.
4. yes:
   a. Add to `.env` and `.env.example`:
      ```bash
      echo 'ENABLE_LSP_TOOL=1' >> .env
      grep -q '^ENABLE_LSP_TOOL=' .env.example 2>/dev/null || echo 'ENABLE_LSP_TOOL=1' >> .env.example
      ```
   b. Detect LSP server from `lsp.server` or `runtime`:

      | runtime | server | install | binary |
      |---------|--------|---------|--------|
      | `bun`/`node`/`deno` | typescript-language-server | bun: `bun add -d typescript-language-server typescript` / pnpm: `pnpm add -D ...` / npm: `npm install --save-dev ...` / yarn: `yarn add --dev ...` | `typescript-language-server` |
      | `python` | pyright | `uv tool install pyright` or `pip install pyright` | `pyright` |
      | `rust` | rust-analyzer | `rustup component add rust-analyzer` | `rust-analyzer` |
      | `go` | gopls | `go install golang.org/x/tools/gopls@latest` | `gopls` |

   c. `which <binary> 2>/dev/null`. missing → run install → re-check. still-missing → ⚠️ "not in PATH — restart shell".
   d. **Claude Code LSP plugin** — detect from runtime:

      | runtime | claude plugin name |
      |---------|--------------------|
      | `bun`/`node`/`deno` | `typescript-lsp` |
      | `python` | `pyright-lsp` |
      | `rust`/`go` | (none — skip) |

      `claude plugin list 2>/dev/null | grep -q '<plugin-name>'` → installed → skip.
      ¬installed → Ask: **Global** (recommended for solo) | **Project** (commits to `.claude/settings.json`) | **Skip**.
      - Global: `claude plugin install <plugin-name>`
      - Project: `claude plugin install <plugin-name> --scope project`
   e. D("LSP", "✅ ENABLE_LSP_TOOL=1 set, <server> installed, <plugin-name> plugin active").
5. Skip → D⏭("LSP").
6. Already set ∧ binary ∃ → check Claude Code plugin (step 4d). D("LSP", "✅ Already configured (<binary>[, plugin missing → run fix])").

## Phase 6 — Report

```
Env Setup Complete
==================

  stack.yml         ✅ Configured / ✅ Already exists / ⏭ Skipped
  Critical Rules    ✅ Scaffolded (N sections) / ✅ Already complete / ⏭ Skipped
  Docs scaffolding  ✅ Created N files / ✅ Already present / ⏭ Skipped
  Fumadocs app      ✅ Created / ⏭ Skipped / ⏭ Not configured
  VS Code MDX       ✅ Added / ✅ Already configured / ⏭ Skipped
  LSP               ✅ Configured / ✅ Already set / ⏭ Disabled / ⏭ Skipped

Next: run /seed-docs to populate docs stubs, or /github-setup to connect GitHub Project.
```

## Safety Rules

1. **Never overwrite existing `.claude/stack.yml` values** without F or explicit confirmation
2. **Always present decisions via protocol** before any write operation
3. **Commit `.claude/stack.yml`** — it holds project stack conventions, not secrets. Gitignore `.env` only.
4. **Idempotent** — skip already-configured items unless F

$ARGUMENTS
