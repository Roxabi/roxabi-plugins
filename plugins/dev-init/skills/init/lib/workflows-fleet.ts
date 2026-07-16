import { APP_MINT_STEP } from '../../shared/adapters/github-infra'
import { ACTION_PINS } from './workflow-pins'
import type { WorkflowOpts } from './workflow-types'

function gatingWorkflowNames(opts: WorkflowOpts): string[] {
  const names = ['CI', 'PR Title', 'Secret Scan', 'Context lint']
  if (opts.e2e === 'playwright') names.push('E2E')
  return names
}

export function generateSecretScanYml(): string {
  return `name: Secret Scan

permissions:
  contents: read

on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main, staging]
  workflow_dispatch: {}

concurrency:
  group: secret-scan-\${{ github.ref }}
  cancel-in-progress: false

jobs:
  trufflehog:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: ${ACTION_PINS.checkout}
        with:
          fetch-depth: 0
      - name: TruffleHog secret scan
        uses: ${ACTION_PINS.trufflehog}
        with:
          extra_args: --only-verified
`
}

/** Map stack → Dependabot package-ecosystem (bun/node → npm; python → pip). */
export function dependabotEcosystemFromStack(stack: WorkflowOpts['stack'] | string): 'npm' | 'pip' {
  return stack === 'python' ? 'pip' : 'npm'
}

/**
 * Full dependabot.yml — application ecosystem + github-actions.
 * Generator owns this file (Phase 1); Phase 1c verifies content completeness.
 * github-actions cooldown: default-days only (semver-*-days rejected by GitHub for gha).
 */
export function generateDependabotYml(
  opts: { stack: WorkflowOpts['stack'] } | { ecosystem: 'npm' | 'pip' } = { stack: 'bun' },
): string {
  const ecosystem = 'ecosystem' in opts ? opts.ecosystem : dependabotEcosystemFromStack(opts.stack)
  return `version: 2
updates:
  - package-ecosystem: ${ecosystem}
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 10
    groups:
      minor-and-patch:
        update-types:
          - minor
          - patch
    labels:
      - dependencies

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    cooldown:
      default-days: 3
    labels:
      - dependencies
      - ci
`
}

export function generateDependabotAutomergeYml(): string {
  return `name: Dependabot Auto-merge

on:
  pull_request_target:
    types: [opened, reopened, synchronize]

permissions:
  contents: read
  pull-requests: read

jobs:
  reviewed-label:
    name: Label dependabot patch/minor reviewed
    if: github.event.pull_request.user.login == 'dependabot[bot]'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
${APP_MINT_STEP}

      - name: Fetch dependabot metadata
        id: meta
        uses: dependabot/fetch-metadata@21025c705c08248db411dc16f3619e6b5f9ea21a  # v2.5.0
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}

      - name: Add reviewed label (patch/minor only)
        if: >-
          steps.meta.outputs.update-type == 'version-update:semver-patch' ||
          steps.meta.outputs.update-type == 'version-update:semver-minor'
        run: gh pr edit "$PR_URL" --add-label reviewed
        env:
          GH_TOKEN: \${{ steps.app.outputs.token }}
          PR_URL: \${{ github.event.pull_request.html_url }}
`
}

export function generateMergeOnGreenYml(opts: WorkflowOpts): string {
  const wakeList = gatingWorkflowNames(opts)
    .map((n) => `      - ${n}`)
    .join('\n')
  return `# Merge-on-green — free-plan private repos where native auto-merge is unavailable.
name: Merge on Green

on:
  pull_request:
    types: [labeled, synchronize, reopened, closed]
  check_suite:
    types: [completed]
  workflow_run:
    workflows:
${wakeList}
    types: [completed]
  workflow_dispatch:
    inputs:
      pr:
        description: PR number to evaluate (optional)
        required: false

permissions:
  contents: read
  pull-requests: read
  issues: write
  checks: read
  statuses: read

jobs:
  merge-on-green:
    name: merge-on-green
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
${APP_MINT_STEP}

      - name: Evaluate green PRs
        id: evaluate
        uses: ${ACTION_PINS.githubScript}
        with:
          github-token: \${{ secrets.GITHUB_TOKEN }}
          script: |
            const SELF_JOB = 'merge-on-green';
            const REQUIRED_LABEL = 'reviewed';
            const toMerge = [];
            const candidates = new Set();
            const dispatchPr = context.payload.inputs?.pr;
            if (dispatchPr) candidates.add(parseInt(dispatchPr, 10));
            else if (context.payload.pull_request) candidates.add(context.payload.pull_request.number);
            else if (context.payload.check_suite) {
              for (const pr of context.payload.check_suite.pull_requests || []) candidates.add(pr.number);
            } else if (context.payload.workflow_run) {
              for (const pr of context.payload.workflow_run.pull_requests || []) candidates.add(pr.number);
            }
            if (candidates.size === 0) {
              const { data: open } = await github.rest.pulls.list({
                owner: context.repo.owner, repo: context.repo.repo, state: 'open', per_page: 100,
              });
              for (const pr of open) {
                if (pr.labels.some((l) => l.name === REQUIRED_LABEL)) candidates.add(pr.number);
              }
            }
            for (const number of candidates) {
              const { data: pr } = await github.rest.pulls.get({
                owner: context.repo.owner, repo: context.repo.repo, pull_number: number,
              });
              if (pr.state !== 'open' || pr.draft || pr.merged) continue;
              if (!pr.labels.some((l) => l.name === REQUIRED_LABEL)) continue;
              if (pr.mergeable === false) continue;
              const runs = await github.paginate(github.rest.checks.listForRef, {
                owner: context.repo.owner, repo: context.repo.repo, ref: pr.head.sha, per_page: 100,
              });
              const others = runs.filter((r) => r.name !== SELF_JOB);
              if (others.some((r) => r.status !== 'completed')) continue;
              if (others.some((r) => r.status === 'completed' && !['success','neutral','skipped'].includes(r.conclusion))) continue;
              toMerge.push(number);
            }
            core.setOutput('to_merge', JSON.stringify(toMerge));

      - name: Merge green PRs
        if: steps.evaluate.outputs.to_merge != '' && steps.evaluate.outputs.to_merge != '[]'
        uses: ${ACTION_PINS.githubScript}
        env:
          TO_MERGE: \${{ steps.evaluate.outputs.to_merge }}
        with:
          github-token: \${{ steps.app.outputs.token }}
          script: |
            for (const number of JSON.parse(process.env.TO_MERGE || '[]')) {
              await github.rest.pulls.merge({
                owner: context.repo.owner, repo: context.repo.repo, pull_number: number, merge_method: 'merge',
              });
            }
`
}

export function generateE2eJob(opts: WorkflowOpts): string {
  if (opts.e2e !== 'playwright') return ''
  return `
  e2e:
    name: E2E
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: ${ACTION_PINS.checkout}
      - uses: ${ACTION_PINS.setupBun}
      - run: bun install
      - name: Install Playwright Chromium
        run: bunx playwright install chromium --with-deps
      - name: E2E tests
        run: bun run test:e2e
        env:
          CI: true
`
}

export function generateCloudflareDeployYml(): string {
  return `name: Deploy (Cloudflare)

# Cloudflare Pages / Workers Builds are git-connected — this workflow documents
# the standard Roxabi pattern; production deploys happen on merge to main/staging.
on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  note:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "Deploy via Cloudflare dashboard git integration (Pages or Workers Builds)."
          echo "See deploy.platform: cloudflare in .claude/stack.yml and /ci-setup cookbook."
`
}
