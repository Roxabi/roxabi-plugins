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

Standard set: `ci.yml`, `auto-merge.yml`, `pr-title.yml` (+ `deploy-preview.yml` if Vercel).

1. Discover owner/repo:
   ```bash
   gh repo view --json owner,name --jq '"\(.owner.login)/\(.name)"'
   ```

2. Check existing via REST:
   ```bash
   gh api /repos/<owner>/<repo>/contents/.github/workflows --jq '.[].name' 2>/dev/null || echo "none"
   ```
   All present → D("CI/CD workflows", "✅ Already configured"), skip.

3. Auto-detect from σ: `stack` ← `runtime`, `test` ← `commands.test` (vitest→Vitest, jest→Jest, pytest→Pytest, else→None), `deploy` ← `deploy.platform`.

4. ∃ missing → Ask: **Set up CI/CD** | **Skip**.

5. yes:
   - Ask stack (pre-select detected): **Bun** | **Node** | **Python (uv)**
   - Ask test (pre-select): **Vitest** | **Jest** | **Pytest** | **None**
   - Ask deploy (pre-select): **Vercel** | **None**
   - Run: `bun $I_TS workflows --owner <owner> --repo <repo> --stack <stack> --test <test> --deploy <deploy>`
   - `gh secret set PAT --repo <owner>/<repo> --body "$(gh auth token)"`
   - Enable auto-merge: `gh api repos/<owner>/<repo> --method PATCH --field allow_auto_merge=true`
   - Re-trigger open PRs with `reviewed` label:
     ```bash
     for pr in $(gh pr list --repo <owner>/<repo> --label reviewed --state open --json number --jq '.[].number'); do
       gh pr edit $pr --remove-label reviewed --repo <owner>/<repo>
       gh pr edit $pr --add-label reviewed --repo <owner>/<repo>
     done
     ```
   - D: `CI/CD workflows ✅ Created` + `PAT secret ✅ Set` + `allow_auto_merge ✅ Enabled` + `Auto-merge re-triggered on N PR(s) ✅` (or ⏭ if none).

6. skip → D⏭("CI/CD workflows").

### Phase 1d — Fumadocs Vercel Deployment (Optional)

Run only if `deploy.platform: vercel` ∧ `docs.framework: fumadocs` in σ.

1. `apps/docs/vercel.json` ∃ → D("Fumadocs Vercel config", "✅ Already present"), skip.
2. Ask: **Add Vercel deployment config** (`apps/docs/vercel.json`) | **Skip**
3. yes:
   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/skills/init/init.ts" scaffold-fumadocs-vercel --root <cwd> --orchestrator <build.orchestrator>
   ```
   `build.orchestrator: turbo` → config with `turbo-ignore @repo/docs`. Other → simple `cd apps/docs && bun run build`.
   D✅("Fumadocs Vercel config — apps/docs/vercel.json").
4. Remind: connect `apps/docs/` as Vercel project (root dir = `apps/docs`), set `NEXT_PUBLIC_APP_URL`.
