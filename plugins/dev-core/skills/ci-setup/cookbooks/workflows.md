# Cookbook: GitHub Actions Workflows

Let:
  I_TS := `${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts`
  Φ    := CLAUDE_PLUGIN_ROOT
  F    := `--force` flag present in `$ARGUMENTS`
  σ    := `.claude/stack.yml`
  D(label, result) := Display: `{label} {result}`
  D✅(label)       := D(label, "✅ Created")
  D⏭(label)       := D(label, "⏭ Skipped")

## Phase 1 — GitHub Actions Workflows

Set up GitHub Actions via REST API (no local git). Runs from σ values.

Standard set: `ci.yml`, `secret-scan.yml`, `dependabot-automerge.yml`, `pr-title.yml`, `context-lint.yml`, merge workflow (`auto-merge.yml` **or** `merge-on-green.yml`), (+ `deploy-preview.yml` if Vercel, + `deploy-cloudflare.yml` if Cloudflare).

1. Discover owner/repo:
   ```bash
   gh repo view --json owner,name --jq '"\(.owner.login)/\(.name)"'
   ```

2. Check existing via REST:
   ```bash
   gh api /repos/<owner>/<repo>/contents/.github/workflows --jq '.[].name' 2>/dev/null || echo "none"
   ```
   All present → D("CI/CD workflows", "✅ Already configured"), skip.

3. Auto-detect from σ:
   - `stack` ← `runtime`
   - `test` ← `testing.unit` first (vitest|jest|pytest|bun|none); if unset, classify `commands.test`:
     - contains `vitest` → vitest | `jest` → jest | `pytest` → pytest
     - `bun test` (not `bun run test`) → bun | `bun run test` → vitest (package script convention)
     - else non-empty command → vitest | empty → none
   - `test-command` ← `commands.test` verbatim (emitted as CI `run:` when set — do not re-derive)
   - `deploy` ← `deploy.platform` (`vercel` | `cloudflare` for `cloudflare*` | `none`)
   - `lint` ← `commands.lint` present → `true`, else `false`
   - `typecheck` ← `commands.typecheck` present → `true`, else `false`
   - `e2e` ← `testing.e2e: playwright` → `playwright`, else `none`

4. ∃ missing → Ask: **Set up CI/CD** | **Skip**.

5. yes:
   - Ask stack (pre-select detected): **Bun** | **Node** | **Python (uv)**
   - Ask test (pre-select): **Vitest** | **Jest** | **Pytest** | **Bun** (native bun:test) | **None**
   - Ask deploy (pre-select): **Vercel** | **Cloudflare** | **None**
   - **Merge strategy** — detect native auto-merge availability:
     ```bash
     gh api repos/<owner>/<repo> --jq '{private: .private, allow_auto_merge: .allow_auto_merge}'
     ```
     - `allow_auto_merge=true` → pre-select **auto-merge** (native merge queue)
     - `allow_auto_merge=false` on private repo → pre-select **merge-on-green** (free-plan pattern)
     - Ask: **auto-merge** | **merge-on-green**
   - Run:
     ```bash
     bun $I_TS workflows --owner <owner> --repo <repo> \
       --stack <stack> --test <test> --deploy <deploy> \
       --merge <auto-merge|merge-on-green> \
       --e2e <playwright|none> \
       --lint <true|false> --typecheck <true|false> \
       --test-command "<commands.test from σ, if set>"
     ```
     > **Top-up par défaut** : les fichiers déjà présents sur le repo sont **skippés** — les repos font évoluer leur `ci.yml` bien au-delà du template (multi-job, e2e, etc.). Ajouter `--force` UNIQUEMENT pour régénérer volontairement, après diff explicite des fichiers qui seraient écrasés.
   - **App token provisioning** (always — PAT mode retired):
     - `gh variable set ROXABI_CI_APP_ID --org <org> --body <app-id>` (org-level)
       OR (private repo / free-plan org): `gh variable set ROXABI_CI_APP_ID --repo <owner>/<repo> --body <app-id>`
     - `gh secret set ROXABI_CI_APP_PRIVATE_KEY --org <org> < key.pem`
       OR: `gh secret set ROXABI_CI_APP_PRIVATE_KEY --repo <owner>/<repo> < key.pem`
     - D: `CI/CD workflows ✅ Created` + `ROXABI_CI_APP_ID var ✅ Set` + `ROXABI_CI_APP_PRIVATE_KEY secret ✅ Set`
   - **If merge = auto-merge:** enable native auto-merge:
     ```bash
     gh api repos/<owner>/<repo> --method PATCH --field allow_auto_merge=true
     ```
     Re-trigger open PRs with `reviewed` label:
     ```bash
     for pr in $(gh pr list --repo <owner>/<repo> --label reviewed --state open --json number --jq '.[].number'); do
       gh pr edit $pr --remove-label reviewed --repo <owner>/<repo>
       gh pr edit $pr --add-label reviewed --repo <owner>/<repo>
     done
     ```
   - **If merge = merge-on-green:** skip `allow_auto_merge` — workflow polls check suites instead.

   > **App creation guide:** see `${CLAUDE_SKILL_DIR}/cookbooks/github-app.md` for how to create and install the `roxabi-ci` App, where `app-id` and `private-key` come from, and the org-free private-repo caveat.

6. skip → D⏭("CI/CD workflows").

### Phase 1d — Fumadocs Vercel Deployment (Optional)

Run only if `deploy.platform: vercel` ∧ `docs.framework: fumadocs` in σ.

1. `apps/docs/vercel.json` ∃ → D("Fumadocs Vercel config", "✅ Already present"), skip.
2. Ask: **Add Vercel deployment config** (`apps/docs/vercel.json`) | **Skip**
3. yes:
   ```bash
   bun $I_TS scaffold-fumadocs-vercel --root <cwd> --orchestrator <build.orchestrator>
   ```
   `build.orchestrator: turbo` → config with `turbo-ignore @repo/docs`. Other → simple `cd apps/docs && bun run build`.
   D✅("Fumadocs Vercel config — apps/docs/vercel.json").
4. Remind: connect `apps/docs/` as Vercel project (root dir = `apps/docs`), set `NEXT_PUBLIC_APP_URL`.