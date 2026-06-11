# Cookbook: dev-core checks

### Phase 1 — dev-core health check

1. Run: `bun ${CLAUDE_PLUGIN_ROOT}/skills/checkup/doctor.ts`
2. Display output directly — pre-formatted.
3. exit ≠ 0 → collect ❌ items; offer Phase 1 Fix per item.

#### Phase 1 Fix

∀ ❌ item, apply matching fix:

| Item | Fix |
|------|-----|
| `GITHUB_REPO` missing | Add `github_repo: owner/repo` to δ (or `GITHUB_REPO=owner/repo` to `.env` fallback) |
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
| `PR_Main` allowed_merge_methods ≠ `["merge"]` | Update ruleset via `gh api repos/:owner/:repo/rulesets/<id> --method PUT` with `allowed_merge_methods: ["merge"]` — merge-commit only (Release Convention); squash/rebase cause history divergence on promotion |
| `PR_Main` ¬targets default branch | Retarget `conditions.ref_name.include` to `["~DEFAULT_BRANCH"]` via `gh api repos/:owner/:repo/rulesets/<id> --method PUT` — a ruleset pinned to `main` protects nothing when default is `staging` |
| secret scanning / push protection disabled | `gh api repos/<owner>/<repo> --method PATCH --input - <<< '{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'` — free on public repos |
| Actions default permissions ≠ read | `gh api repos/<owner>/<repo>/actions/permissions/workflow --method PUT -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false` |
| `pull_request_target` checks out PR head | Switch trigger to `pull_request`, or drop the PR-head `ref:` from checkout — never run PR-authored code with secrets in scope |
| `trufflehog` not in `.pre-commit-config.yaml` | Add the trufflehog repo/hook to `.pre-commit-config.yaml` (mirror an existing Roxabi Python repo) |
| `trufflehog` not in CI | Add `secret-scan.yml` workflow — `/ci-setup` Phase 1b |
| no hook manager at all | Run `/init` Phase 10d (lefthook) or add `.pre-commit-config.yaml` |

Issues requiring interactive auth / multi-step scaffolding → display exact command + explanation. Never silently redirect.
