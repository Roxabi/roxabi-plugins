/**
 * Generate and push GitHub Actions workflow files.
 * Supports both local write (writeWorkflows) and REST API push (pushWorkflows).
 */

import { run } from '../../shared/github'

export interface WorkflowOpts {
  stack: 'bun' | 'node' | 'python'
  test: 'vitest' | 'jest' | 'pytest' | 'none'
  deploy: 'vercel' | 'none'
}

// --- Content generators ---

/** Generic auto-merge workflow: enables merge queue on 'reviewed' label,
 *  updates behind PRs on push, closes linked issues on merge. */
export function generateAutoMergeYml(): string {
  return `# Auto-merge PRs that have been reviewed and passed all required checks.
# Adds the PR to GitHub's merge queue (squash) once the "reviewed" label is present.
# GitHub natively waits for all required status checks before merging.
#
# Also closes linked issues after merge, because GITHUB_TOKEN-initiated
# auto-merges don't trigger GitHub's native "Closes #X" issue closure.
name: Auto Merge

on:
  pull_request:
    types: [labeled, synchronize, closed]
  check_suite:
    types: [completed]
  push:
    branches: [staging, main]

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  auto-merge:
    name: Enable auto-merge
    runs-on: ubuntu-latest
    if: >-
      github.event.action != 'closed' &&
      contains(github.event.pull_request.labels.*.name, 'reviewed')
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Enable auto-merge (squash)
        run: gh pr merge "$PR_NUMBER" --auto --squash
        env:
          GH_TOKEN: \${{ secrets.PAT }}
          PR_NUMBER: \${{ github.event.pull_request.number }}

  update-behind-prs:
    name: Update behind PRs
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    timeout-minutes: 5
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Update all reviewed PRs targeting this branch
        run: |
          BRANCH="\${GITHUB_REF_NAME}"
          PRS=$(gh pr list --base "$BRANCH" --label reviewed --state open --json number,headRefOid --jq '.[]')
          if [ -z "$PRS" ]; then
            echo "No reviewed PRs targeting $BRANCH"
            exit 0
          fi
          echo "$PRS" | while IFS= read -r pr; do
            NUM=$(echo "$pr" | jq -r .number)
            SHA=$(echo "$pr" | jq -r .headRefOid)
            echo "Updating PR #$NUM..."
            gh api "repos/\${{ github.repository }}/pulls/$NUM/update-branch" \\
              --method PUT -f expected_head_sha="$SHA" || true
          done
        env:
          GH_TOKEN: \${{ secrets.PAT }}

  close-linked-issues:
    name: Close linked issues
    runs-on: ubuntu-latest
    if: github.event.action == 'closed' && github.event.pull_request.merged == true
    timeout-minutes: 5
    steps:
      - name: Close issues referenced with closing keywords
        uses: actions/github-script@v7
        with:
          script: |
            const body = context.payload.pull_request.body || '';
            const pattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#(\\d+)/gi;
            const issues = new Set();
            let match;
            while ((match = pattern.exec(body)) !== null) {
              issues.add(parseInt(match[1]));
            }
            if (issues.size === 0) {
              core.info('No closing keywords found in PR body');
              return;
            }
            for (const number of issues) {
              try {
                await github.rest.issues.update({
                  owner: context.repo.owner,
                  repo: context.repo.repo,
                  issue_number: number,
                  state: 'closed',
                  state_reason: 'completed',
                });
                core.info(\`Closed issue #\${number}\`);
              } catch (error) {
                core.warning(\`Failed to close issue #\${number}: \${error.message}\`);
              }
            }
`
}

/** Generic PR title validator — enforces Conventional Commits format. */
export function generatePrTitleYml(): string {
  return `name: PR Title

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
    branches: [main, staging]

permissions:
  pull-requests: read

jobs:
  pr-title:
    name: Validate PR Title
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Check PR title follows Conventional Commits
        uses: amannn/action-semantic-pull-request@v5
        with:
          types: |
            feat
            fix
            refactor
            docs
            style
            test
            chore
            ci
            perf
            build
            revert
          requireScope: false
          allowMergeCommits: true
          allowRevertCommits: true
          ignoredAuthors: |
            dependabot[bot]
            renovate[bot]
          subjectPattern: ^.+$
          subjectPatternError: "PR title must have a non-empty description after the type/scope prefix."
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
`
}

export function generateCiYml(opts: WorkflowOpts): string {
  let setupStep: string
  let lintCmd: string
  let typecheckCmd: string

  let testStep = ''

  if (opts.stack === 'python') {
    setupStep =
      '      - name: Install uv\n        uses: astral-sh/setup-uv@v5\n      - name: Install dependencies\n        run: uv sync --frozen --all-extras'
    lintCmd = 'uv run ruff check .'
    typecheckCmd = 'uv run pyright'
    if (opts.test === 'pytest') {
      testStep = '\n      - name: Test\n        run: uv run pytest'
    }
  } else if (opts.stack === 'bun') {
    setupStep = '      - uses: oven-sh/setup-bun@v2\n      - run: bun install'
    lintCmd = 'bun lint'
    typecheckCmd = 'bun typecheck'
    if (opts.test !== 'none') {
      testStep = '\n      - name: Test\n        run: bun test'
    }
  } else {
    setupStep = '      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci'
    lintCmd = 'npm run lint'
    typecheckCmd = 'npx tsc --noEmit'
    if (opts.test !== 'none') {
      testStep = '\n      - name: Test\n        run: npm test'
    }
  }

  return `name: CI
on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main, staging]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setupStep}
      - name: Lint
        run: ${lintCmd}
      - name: Typecheck
        run: ${typecheckCmd}${testStep}
`
}

export function generateDeployYml(opts: WorkflowOpts): string {
  const setupStep =
    opts.stack === 'bun'
      ? '      - uses: oven-sh/setup-bun@v2\n      - run: bun install'
      : '      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm ci'

  let deployStep: string
  if (opts.deploy === 'vercel') {
    deployStep = `      - name: Deploy to Vercel
        run: npx vercel deploy --token \${{ secrets.VERCEL_TOKEN }} --\${{ inputs.target == 'production' && '' || 'no-' }}prod
        env:
          VERCEL_ORG_ID: \${{ secrets.VERCEL_ORG_ID }}
          VERCEL_PROJECT_ID: \${{ secrets.VERCEL_PROJECT_ID }}`
  } else {
    deployStep = `      - name: Deploy
        run: echo "No deploy target configured — update this workflow"`
  }

  return `name: Deploy Preview
on:
  workflow_dispatch:
    inputs:
      target:
        description: 'Deploy target'
        required: true
        default: 'preview'
        type: choice
        options:
          - preview
          - production

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${setupStep}
${deployStep}
`
}

// --- REST API push ---

async function getToken(): Promise<string> {
  return (await run(['gh', 'auth', 'token'])).trim()
}

async function pushWorkflowFile(
  owner: string,
  repo: string,
  filename: string,
  content: string,
  token: string,
  branch = 'main',
): Promise<'created' | 'updated'> {
  const b64 = Buffer.from(content).toString('base64')
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/${filename}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const checkRes = await fetch(url, { headers })
  const existing = checkRes.ok ? ((await checkRes.json()) as { sha: string }) : null

  const body: Record<string, string> = {
    message: `chore: ${existing ? 'update' : 'add'} ${filename} workflow`,
    content: b64,
    branch,
  }
  if (existing?.sha) body.sha = existing.sha

  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = (await res.json()) as { message?: string }
    throw new Error(`Failed to push ${filename}: ${err.message ?? JSON.stringify(err)}`)
  }

  return existing ? 'updated' : 'created'
}

export interface PushResult {
  file: string
  status: 'created' | 'updated'
}

/** Push all workflow files to a remote repo via GitHub REST API. No local git required. */
export async function pushWorkflows(
  owner: string,
  repo: string,
  opts: WorkflowOpts,
  branch = 'main',
): Promise<PushResult[]> {
  const token = await getToken()
  const files: Array<{ name: string; content: string }> = [
    { name: 'auto-merge.yml', content: generateAutoMergeYml() },
    { name: 'pr-title.yml', content: generatePrTitleYml() },
    { name: 'ci.yml', content: generateCiYml(opts) },
  ]
  if (opts.deploy === 'vercel') {
    files.push({ name: 'deploy-preview.yml', content: generateDeployYml(opts) })
  }

  const results: PushResult[] = []
  for (const { name, content } of files) {
    const status = await pushWorkflowFile(owner, repo, name, content, token, branch)
    results.push({ file: name, status })
  }
  return results
}

/** Push a specific subset of workflow files (e.g. only the generic ones). */
export async function pushGenericWorkflows(owner: string, repo: string, branch = 'main'): Promise<PushResult[]> {
  const token = await getToken()
  const files = [
    { name: 'auto-merge.yml', content: generateAutoMergeYml() },
    { name: 'pr-title.yml', content: generatePrTitleYml() },
  ]
  const results: PushResult[] = []
  for (const { name, content } of files) {
    const status = await pushWorkflowFile(owner, repo, name, content, token, branch)
    results.push({ file: name, status })
  }
  return results
}

/** Write workflow files to the local filesystem (legacy / offline use). */
export async function writeWorkflows(opts: WorkflowOpts): Promise<string[]> {
  const fs = require('node:fs')
  const dir = '.github/workflows'
  fs.mkdirSync(dir, { recursive: true })

  const written: string[] = []

  fs.writeFileSync(`${dir}/ci.yml`, generateCiYml(opts))
  written.push('ci.yml')

  fs.writeFileSync(`${dir}/auto-merge.yml`, generateAutoMergeYml())
  written.push('auto-merge.yml')

  fs.writeFileSync(`${dir}/pr-title.yml`, generatePrTitleYml())
  written.push('pr-title.yml')

  if (opts.deploy === 'vercel') {
    fs.writeFileSync(`${dir}/deploy-preview.yml`, generateDeployYml(opts))
    written.push('deploy-preview.yml')
  }

  return written
}
