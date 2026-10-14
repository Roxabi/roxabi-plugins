# Cookbook: GitHub App Setup (roxabi-ci)

Guide for creating the `roxabi-ci` GitHub App and wiring `ROXABI_CI_APP_ID` / `ROXABI_CI_APP_PRIVATE_KEY` into CI workflows.

## Why App tokens instead of PAT

- Ephemeral (1 h) — minimal blast radius if leaked
- Pushes from the App token re-trigger `ci.yml` — `GITHUB_TOKEN` silently cannot
- No coupling to a personal account — survives staff changes
- Scoped to the installation target (org or specific repos)

## Create the App

1. GitHub → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**
2. Fill in:
   - **GitHub App name:** `roxabi-ci` (or `<org>-ci` for non-Roxabi orgs)
   - **Homepage URL:** org URL (e.g. `https://github.com/Roxabi`)
   - **Webhooks:** uncheck "Active" (no webhooks needed)
3. **Permissions → Repository permissions:**
   - `Contents`: Read & write (create commits, tags, release PRs)
   - `Pull requests`: Read & write (open/update release PRs, auto-merge)
   - `Actions`: Read (read workflow runs — needed to check status)
   - `Metadata`: Read (auto-selected, required)
4. **Where can this GitHub App be installed?** → choose scope:
   - "Only on this account" → single-account App (simpler)
   - "Any account" → public App (not needed for org-internal CI)
5. Click **Create GitHub App**.

## Get the App ID

After creation, the App settings page shows a numeric **App ID** (e.g. `12345678`).

```bash
# Set as an org variable (applies to all org repos):
gh variable set ROXABI_CI_APP_ID --org <org> --body 12345678

# Or repo-level (see private-repo caveat below):
gh variable set ROXABI_CI_APP_ID --repo <owner>/<repo> --body 12345678
```

## Generate and store the private key

1. App settings page → **Private keys** section → **Generate a private key**
2. A `.pem` file downloads (keep it — GitHub shows it once)
3. Store as an org or repo secret:

```bash
# Org-level (applies to all org repos):
gh secret set ROXABI_CI_APP_PRIVATE_KEY --org <org> < ~/Downloads/roxabi-ci.YYYY-MM-DD.private-key.pem

# Or repo-level (see private-repo caveat below):
gh secret set ROXABI_CI_APP_PRIVATE_KEY --repo <owner>/<repo> < ~/Downloads/roxabi-ci.YYYY-MM-DD.private-key.pem
```

## Install the App

1. App settings page → **Install App** → select the org (or specific repos)
2. Confirm permissions. GitHub now grants the App an installation on the selected scope.

The mint step (`actions/create-github-app-token`) uses this installation to exchange credentials for a short-lived token at job runtime.

## Mint step (SHA-pinned)

Emitted automatically by `/init` (ci-setup + release-setup) in github-app mode:

```yaml
      - uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1  # v3.2.0
        id: app
        with:
          app-id: ${{ vars.ROXABI_CI_APP_ID }}
          private-key: ${{ secrets.ROXABI_CI_APP_PRIVATE_KEY }}
```

Consumers: `${{ steps.app.outputs.token }}`. NEVER use a floating tag.

## Private-repo caveat (org free plan)

> **Org-level Actions secrets and variables do NOT propagate to private repositories on a free-plan org.**

On GitHub Free, org secrets/variables are only visible to public repos. Private repos on a free org must be configured at repo level:

```bash
gh variable set ROXABI_CI_APP_ID \
  --repo <owner>/<repo> \
  --body <app-id>

gh secret set ROXABI_CI_APP_PRIVATE_KEY \
  --repo <owner>/<repo> \
  < key.pem
```

Upgrading to GitHub Team/Enterprise removes this restriction — org-level credentials then reach private repos.

## Dependabot note

Dependabot-triggered workflow runs have a separate secret store. If Dependabot PRs must mint an App token (e.g. auto-merge on dependency bumps), set the Dependabot secret as well:

```bash
gh secret set ROXABI_CI_APP_PRIVATE_KEY \
  --repo <owner>/<repo> \
  --app dependabot \
  < key.pem
```

`ROXABI_CI_APP_ID` does not need a Dependabot equivalent — it is a variable, not a secret, and variables are readable by Dependabot.

## Verifying the installation

After setting credentials, trigger any workflow that uses the mint step (e.g. push to `main`). Check the job logs for the "Mint app token (roxabi-ci)" step — it should show "Token created" with an expiry ~1 h from job start.
