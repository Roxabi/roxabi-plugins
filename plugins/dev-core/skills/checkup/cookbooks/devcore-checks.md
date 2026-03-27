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
