---
name: env-setup
argument-hint: '[--force]'
description: 'Set up local dev environment — stack.yml, CLAUDE.md Critical Rules, docs scaffolding, VS Code MDX, LSP. Triggered by /dev-init:init or standalone /env-setup. Triggers: "env setup" | "setup environment" | "configure stack" | "scaffold rules".'
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

### Phase 1b — Worktree-setup retrofit

For projects that already have σ but pre-date the worktree-setup hook. Detect the
gap and offer to scaffold `tools/worktree-setup.sh` + teardown. All steps are
inlined here — cross-skill prose references do not bind at runtime.

Let:
  WS  := tools/worktree-setup.sh
  WT  := tools/worktree-teardown.sh
  CL  := ${CLAUDE_PLUGIN_ROOT}/references/worktree-setup-checklist.md
  TS  := ${CLAUDE_PLUGIN_ROOT}/tools/worktreeScaffold.ts
  σ_has_hook       := `grep -q 'worktree_setup:' .claude/stack.yml`
  runtime_supported := σ.runtime ∈ {python, bun, node}

1. **σ missing** → D⏭("Worktree-setup retrofit — requires stack.yml"), skip.
2. **σ_has_hook true** → D("Worktree-setup retrofit", "✅ Already configured"), skip.
3. **runtime_supported false** → D⏭("Worktree-setup retrofit — runtime not in scope"), skip.
4. **Wider probe** — check for existing worktree-setup scripts under non-canonical names:
   ```bash
   ALT_SCRIPT=$(grep -rl 'worktree[-_]setup' tools/*.sh scripts/*.sh 2>/dev/null | head -1)
   ```
   ALT_SCRIPT ∃ ∧ ALT_SCRIPT ≠ "tools/worktree-setup.sh" →
     D("Worktree-setup retrofit", "⚠️  Found existing worktree-setup script at ${ALT_SCRIPT} (not tools/worktree-setup.sh). Skipping scaffold — move it to tools/worktree-setup.sh or delete and re-run."), skip.
5. **test -f tools/worktree-setup.sh** ∧ ¬F → D("Worktree-setup retrofit", "⏭ Script present, σ key missing — fix σ only").
   - Append `commands.worktree_setup: tools/worktree-setup.sh` + `commands.worktree_teardown: tools/worktree-teardown.sh` under `commands:` in σ.
   - D✅("Worktree-setup retrofit — σ keys added"), skip remainder.
6. **Both absent** → present choice **Scaffold worktree-setup hook now** | **Skip**.
   - **Skip** → D⏭("Worktree-setup retrofit"), continue.
   - **Scaffold** → execute the following inline (verbatim duplication of stack-setup Phase 4b — required because cross-skill references do not bind at runtime):
     a. Re-detect variables from σ and filesystem:
        ```bash
        RUNTIME=$(grep '^runtime:' .claude/stack.yml | awk '{print $2}')
        PM=$(grep '^package_manager:' .claude/stack.yml | awk '{print $2}')
        MONOREPO_BOOL=$([ -f turbo.jsonc ] || [ -f turbo.json ] || [ -f nx.json ] && echo true || echo false)
        HOOKS_TOOL=$([ -f lefthook.yml ] || [ -f .lefthook.yml ] && echo lefthook \
          || ([ -f .pre-commit-config.yaml ] && echo pre-commit) || echo none)
        DATABASE=$(grep -lE 'NEON_DATABASE_URL|@neondatabase' .env.example apps/api/package.json 2>/dev/null \
          | head -1 > /dev/null && echo neon || echo none)
        BE_PATH=$(grep -oP '(?<=packages = \[")[^"]+' pyproject.toml 2>/dev/null | head -1 \
          || (test -d apps/api && echo apps/api) || echo "")
        ENV_FILES=$(ls .env.example .env.local 2>/dev/null | head -3 | tr '\n' ' ' || echo "")
        ```
     b. Build CTX_JSON safely via jq:
        ```bash
        command -v jq > /dev/null 2>&1 || { echo "jq not found — install jq to continue"; exit 1; }
        CTX_JSON=$(jq -n \
          --arg runtime "$RUNTIME" \
          --arg pm "$PM" \
          --argjson monorepo "${MONOREPO_BOOL}" \
          --arg hooks_tool "${HOOKS_TOOL:-lefthook}" \
          --arg database "${DATABASE:-none}" \
          --arg be_path "${BE_PATH:-}" \
          --arg env_files "${ENV_FILES:-}" \
          '{
            runtime: $runtime,
            package_manager: $pm,
            monorepo: $monorepo,
            hooks_tool: $hooks_tool,
            env_files: ($env_files | split(" ") | map(select(. != ""))),
            database: $database,
            backend_paths: ($be_path | if . == "" then [] else [.] end)
          }')
        ```
     c. Preview:
        ```bash
        IDS=$(bun "${TS}" list-selected --checklist "${CL}" --context-json "${CTX_JSON}")
        COUNT=$(echo "$IDS" | awk -F, '{print NF}')
        ```
        Echo: `Worktree-setup retrofit preview — ${RUNTIME}/${PM} · ${COUNT} concerns: ${IDS}`
        COUNT == 0 → D⏭("Worktree-setup retrofit — no concerns matched"), skip.
     d. user choice **Write scripts** | **Preview composed body** | **Abort**.
        - **Preview composed body** → `bun "${TS}" compose --checklist "${CL}" --context-json "${CTX_JSON}" --mode setup | head -80`, then re-present user choice **Write scripts** | **Abort**.
        - **Abort** → D⏭("Worktree-setup retrofit"), skip.
     e. Write:
        ```bash
        mkdir -p tools
        bun "${TS}" compose --checklist "${CL}" --context-json "${CTX_JSON}" --mode setup > tools/worktree-setup.sh
        bun "${TS}" compose --checklist "${CL}" --context-json "${CTX_JSON}" --mode teardown > tools/worktree-teardown.sh
        chmod +x tools/worktree-setup.sh tools/worktree-teardown.sh
        ```
     f. Register keys in σ (idempotent — skip lines already present):
        Append under `commands:` in `.claude/stack.yml`:
        ```yaml
          worktree_setup: tools/worktree-setup.sh
          worktree_teardown: tools/worktree-teardown.sh
        ```
     g. D("Worktree-setup retrofit", "✅ Written (${COUNT} concerns: ${IDS}), σ keys registered").

Re-run idempotency: any subsequent `/env-setup` invocation re-evaluates the predicate — once σ has the key, step 2 short-circuits silently.

## Phase 2 — Scaffold CLAUDE.md Critical Rules

Generate governance rules (dev process, decision protocol, git conventions, etc.) from σ values. Sections vary by project type.

σ ∄ → D("Critical Rules", "⏭ Skipped — requires stack.yml"), skip to Phase 3.

1. Run: `bun $I_TS scaffold-rules --stack-path .claude/stack.yml --claude-md CLAUDE.md`
2. Parse JSON → extract `projectType`, `sections`, `markdown`, `existing`, `facts`.
3. Display:
   ```
   Project type: {projectType}
   Repo facts:   baseBranch={facts.baseBranch}  pm={facts.packageManager}  .env.example={facts.hasEnvExample}
   Parent CLAUDE.md: {existing.parentPaths joined | "none"}
   Parent @imports:  {existing.parentImports joined | "none"}  ← machine-local; not auto-skip authority
   Local sections:   {existing.sectionIds or "none"}
   Sections to scaffold: {sections.length} ({section ids})
   ```
   > Parent context is **reporting only**. Silent auto-skip is forbidden — parent/ssot paths are often machine-local; committed CLAUDE.md must stay portable for clones without that parent.
4. Present choice (always a gate — user is the gate):
   - **Scaffold full** — all generated sections (portable governance for any clone)
   - **Scaffold project-local only** — tldr + artifact-model + coding-standards + gotchas (when parent already loads fleet rules)
   - **Merge** — append only section ids missing from `existing.sectionIds` (local titles only)
   - **Skip**
   When `existing.sectionIds` already covers all expected → still show table; default bias **Skip** / already complete.
5. Scaffold full / project-local / Replace → write `markdown` (for project-local: filter sections to ids ∈ {tldr, artifact-model, coding-standards, gotchas}, renumber). Preserve content before/after `## Critical Rules` if present.
6. Merge → ∀ section ∈ chosen set ∧ section.id ∉ existing.sectionIds → append after last existing Critical Rules heading.
7. D("Critical Rules", "✅ Scaffolded ({N} sections for {projectType}, base={facts.baseBranch})")

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
  Worktree-setup    ✅ Scaffolded / ✅ Already configured / ⏭ Skipped

Next: run /seed-docs to populate docs stubs. Issue triage (labels, blocked-by, parent/child) lives in the separate **roxabi-issues** plugin.
```

## Safety Rules

1. **Never overwrite existing `.claude/stack.yml` values** without F or explicit confirmation
2. **Always present choices and wait for user reply** before any write operation
3. **Commit `.claude/stack.yml`** — it holds project stack conventions, not secrets. Gitignore `.env` only.
4. **Idempotent** — skip already-configured items unless F

$ARGUMENTS
