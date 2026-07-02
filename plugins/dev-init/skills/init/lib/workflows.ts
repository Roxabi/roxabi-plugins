/**
 * Generate and push GitHub Actions workflow files.
 * Supports both local write (writeWorkflows) and REST API push (pushWorkflows).
 */

import { run } from '../../shared/adapters/github-adapter'
import { APP_MINT_STEP } from '../../shared/adapters/github-infra'
import { ACTION_PINS } from './workflow-pins'
import { normalizeWorkflowOpts, type WorkflowOpts } from './workflow-types'
import {
  generateCloudflareDeployYml,
  generateDependabotAutomergeYml,
  generateDependabotYml,
  generateE2eJob,
  generateMergeOnGreenYml,
  generateSecretScanYml,
} from './workflows-fleet'

export type { WorkflowOpts } from './workflow-types'
export { normalizeWorkflowOpts }

// --- Content generators ---

/** Generic auto-merge workflow: enables merge queue on 'reviewed' label,
 *  updates behind PRs on push, closes linked issues on merge. */
export function generateAutoMergeYml(): string {
  return `# Auto-merge PRs that have been reviewed and passed all required checks.
# Adds the PR to GitHub's merge queue (merge commit) once the "reviewed" label is present.
# GitHub natively waits for all required status checks before merging.
# Uses merge commit (not squash) to preserve history — required for staging→main promotions.
#
# Dependabot guard: semver-major bumps are never auto-merged — they require
# manual validation before merge.
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
${APP_MINT_STEP}

      - name: Block dependabot semver-major bumps
        if: github.event.pull_request.user.login == 'dependabot[bot]'
        env:
          GH_TOKEN: \${{ steps.app.outputs.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          PR_TITLE: \${{ github.event.pull_request.title }}
        run: |
          if [[ "$PR_TITLE" =~ from\\ v?([0-9]+)[^\\ ]*\\ to\\ v?([0-9]+) ]] && [ "\${BASH_REMATCH[1]}" != "\${BASH_REMATCH[2]}" ]; then
            gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPOSITORY" \\
              --body "Auto-merge refused: **semver-major** bump. Manual validation required (e2e / boot the artifact), then merge by hand."
            echo "::error::semver-major dependency bump — auto-merge refused"
            exit 1
          fi

      - name: Update branch (lazy sync for late joiners)
        if: contains(github.event.pull_request.labels.*.name, 'reviewed')
        env:
          GH_TOKEN: \${{ steps.app.outputs.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}
          PR_HEAD_SHA: \${{ github.event.pull_request.head.sha }}
        run: |
          gh api "repos/$GITHUB_REPOSITORY/pulls/$PR_NUMBER/update-branch" \\
            --method PUT -f expected_head_sha="$PR_HEAD_SHA" || true

      - name: Enable auto-merge (merge commit)
        run: gh pr merge "$PR_NUMBER" --auto --merge --repo "$GITHUB_REPOSITORY"
        env:
          GH_TOKEN: \${{ steps.app.outputs.token }}
          PR_NUMBER: \${{ github.event.pull_request.number }}

  update-behind-prs:
    name: Update behind PRs
    runs-on: ubuntu-latest
    if: github.event_name == 'push'
    timeout-minutes: 5
    steps:
${APP_MINT_STEP}

      - name: Update all reviewed PRs targeting this branch
        run: |
          BRANCH="\${GITHUB_REF_NAME}"
          PRS=$(gh pr list --repo "$GITHUB_REPOSITORY" --base "$BRANCH" --label reviewed --state open --json number,headRefOid --jq '.[]')
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
          GH_TOKEN: \${{ steps.app.outputs.token }}

  close-linked-issues:
    name: Close linked issues
    runs-on: ubuntu-latest
    if: github.event.action == 'closed' && github.event.pull_request.merged == true
    timeout-minutes: 5
    steps:
      - name: Close issues referenced with closing keywords
        uses: ${ACTION_PINS.githubScript}
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
        uses: ${ACTION_PINS.semanticPr}
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

/** Generic context lint — keeps agent-context files honest:
 *  repo-relative `@imports` in harness context files must resolve, and scaffold
 *  placeholders must be filled. Covers Claude (.claude/rules, CLAUDE.md) and Grok
 *  (.grok/rules, .grok/skills/SKILL.md, .grok/agents). Home-dir imports (`@~/...`)
 *  are machine-local and skipped on CI. Stack-agnostic (pure bash, no deps).
 *  Ecosystem-level checks (project index, factory registry) live in the central
 *  ~/projects/scripts/context-lint.sh, deliberately not here. */
export function generateContextLintYml(): string {
  return `name: Context Lint

on:
  pull_request:
    paths:
      - '**/CLAUDE.md'
      - '**/AGENTS.md'
      - '.claude/**'
      - '.grok/**'
      - '.agents/**'
  push:
    branches: [main, staging]
    paths:
      - '**/CLAUDE.md'
      - '**/AGENTS.md'
      - '.claude/**'
      - '.grok/**'
      - '.agents/**'

permissions:
  contents: read

jobs:
  context-lint:
    name: Context lint
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: ${ACTION_PINS.checkout}
      - name: Lint agent-context files (@imports + placeholders)
        run: |
          set -u
          V=0
          find_context_files() {
            find . \\( -name node_modules -o -name .worktrees -o -name worktrees -o -name .git \\) -prune -o -type f \\( \\
              -name 'CLAUDE.md' -o -name 'AGENTS.md' -o \\
              \\( -name 'SKILL.md' \\( -path '*/.grok/skills/*' -o -path '*/.claude/skills/*' -o -path '*/.agents/skills/*' \\) \\) -o \\
              \\( -name '*.md' \\( -path '*/.grok/rules/*' -o -path '*/.claude/rules/*' -o -path '*/.grok/agents/*' \\) \\) \\
            \\) -print
          }
          # dead repo-relative @imports (home-dir @~/... imports are machine-local — skipped on CI)
          while IFS= read -r file; do
            dir=$(dirname "$file")
            while IFS= read -r imp; do
              target=\${imp#@}
              case "$target" in "~/"*|/*) continue ;; esac
              if [ ! -e "$dir/$target" ]; then
                echo "::error file=$file::dead @import: $imp"
                V=$((V + 1))
              fi
            done < <(grep -o '^@[^ ]*' "$file" || true)
          done < <(find_context_files)
          # unfilled scaffold placeholders
          while IFS= read -r f; do
            echo "::error file=$f::unfilled scaffold placeholder (gotchas)"
            V=$((V + 1))
          done < <(grep -rl 'Add project-specific gotchas here' --include=CLAUDE.md . 2>/dev/null || true)
          if [ "$V" -eq 0 ]; then
            echo "context-lint: clean"
          else
            echo "context-lint: $V violation(s)"
            exit 1
          fi
`
}

/** Push only context-lint.yml (always updates — safe to re-run after generator changes). */
export async function pushContextLintYml(
  owner: string,
  repo: string,
  branch: string,
): Promise<'created' | 'updated' | 'skipped'> {
  return pushWorkflowFile(owner, repo, '.github/workflows/context-lint.yml', generateContextLintYml(), {
    branch,
    message: 'chore: update context-lint.yml (Grok + Claude harness paths)',
    skipExisting: false,
  })
}

export function generateCiYml(opts: WorkflowOpts): string {
  const o = normalizeWorkflowOpts(opts)
  let setupStep: string
  let lintStep = ''
  let typecheckStep = ''
  let testStep = ''

  if (o.stack === 'python') {
    setupStep = `      - uses: ${ACTION_PINS.setupUv}
      - name: Install dependencies
        run: uv sync --frozen --all-extras`
    if (o.lint) lintStep = '\n      - name: Lint\n        run: uv run ruff check .'
    if (o.typecheck) typecheckStep = '\n      - name: Typecheck\n        run: uv run pyright'
    if (o.test === 'pytest') testStep = '\n      - name: Test\n        run: uv run pytest'
  } else if (o.stack === 'bun') {
    setupStep = `      - uses: ${ACTION_PINS.setupBun}
      - run: bun install`
    if (o.lint) lintStep = '\n      - name: Lint\n        run: bun lint'
    if (o.typecheck) typecheckStep = '\n      - name: Typecheck\n        run: bun typecheck'
    if (o.test !== 'none') {
      const bunTestCmd = o.test === 'vitest' ? 'bun run test' : 'bun test'
      testStep = `\n      - name: Test\n        run: ${bunTestCmd}`
    }
  } else {
    setupStep = `      - uses: ${ACTION_PINS.setupNode}
        with:
          node-version: 20
      - run: npm ci`
    if (o.lint) lintStep = '\n      - name: Lint\n        run: npm run lint'
    if (o.typecheck) typecheckStep = '\n      - name: Typecheck\n        run: npx tsc --noEmit'
    if (o.test !== 'none') testStep = '\n      - name: Test\n        run: npm test'
  }

  return `name: CI
on:
  push:
    branches: [main, staging]
  pull_request:
    branches: [main, staging]

jobs:
  ci:
    name: CI
    runs-on: ubuntu-latest
    steps:
      - uses: ${ACTION_PINS.checkout}
${setupStep}${lintStep}${typecheckStep}${testStep}
${generateE2eJob(o)}`
}

export function generateDeployYml(opts: WorkflowOpts): string {
  const setupStep =
    opts.stack === 'bun'
      ? `      - uses: ${ACTION_PINS.setupBun}\n      - run: bun install`
      : `      - uses: ${ACTION_PINS.setupNode}\n        with:\n          node-version: 20\n      - run: npm ci`

  let deployStep: string
  if (opts.deploy === 'cloudflare') {
    deployStep = `      - name: Deploy (Cloudflare git integration)
        run: echo "Use Cloudflare Pages/Workers Builds git integration — see stack.yml deploy.platform"`
  } else if (opts.deploy === 'vercel') {
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
      - uses: ${ACTION_PINS.checkout}
${setupStep}
${deployStep}
`
}

// --- REST API push ---

async function getToken(): Promise<string> {
  return (await run(['gh', 'auth', 'token'])).trim()
}

/** Push a single file to a repo via the GH contents API (create-or-update).
 *  `path` is the full repo-relative path (e.g. `.github/workflows/ci.yml`).
 *  With `skipExisting`, a file already present is left untouched ('skipped') —
 *  repos evolve their workflows past the templates, so overwrite must be opt-in. */
export async function pushWorkflowFile(
  owner: string,
  repo: string,
  path: string,
  content: string,
  opts: { branch: string; message?: string; skipExisting?: boolean },
): Promise<'created' | 'updated' | 'skipped'> {
  const token = await getToken()
  const { branch } = opts
  const b64 = Buffer.from(content).toString('base64')
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  const checkRes = await fetch(url, { headers })
  const existing = checkRes.ok ? ((await checkRes.json()) as { sha: string }) : null
  if (existing && opts.skipExisting) return 'skipped'

  const body: Record<string, string> = {
    message: opts?.message ?? `chore: ${existing ? 'update' : 'add'} ${path}`,
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
    throw new Error(`Failed to push ${path}: ${err.message ?? JSON.stringify(err)}`)
  }

  return existing ? 'updated' : 'created'
}

export interface PushResult {
  file: string
  status: 'created' | 'updated' | 'skipped'
}

/** Push all workflow files to a remote repo via GitHub REST API. No local git required.
 *  Default is TOP-UP: files already present on the repo are skipped (repos evolve
 *  their ci.yml far past the template). `force` overwrites. */
export async function pushWorkflows(
  owner: string,
  repo: string,
  opts: WorkflowOpts,
  branch: string,
  force = false,
): Promise<PushResult[]> {
  const o = normalizeWorkflowOpts(opts)
  const mergeFile =
    o.merge === 'merge-on-green'
      ? { name: 'merge-on-green.yml', content: generateMergeOnGreenYml(o) }
      : { name: 'auto-merge.yml', content: generateAutoMergeYml() }
  const files: Array<{ name: string; content: string }> = [
    mergeFile,
    { name: 'pr-title.yml', content: generatePrTitleYml() },
    { name: 'context-lint.yml', content: generateContextLintYml() },
    { name: 'secret-scan.yml', content: generateSecretScanYml() },
    { name: 'ci.yml', content: generateCiYml(o) },
    { name: 'dependabot-automerge.yml', content: generateDependabotAutomergeYml() },
  ]
  if (o.deploy === 'vercel') {
    files.push({ name: 'deploy-preview.yml', content: generateDeployYml(o) })
  }
  if (o.deploy === 'cloudflare') {
    files.push({ name: 'deploy-cloudflare.yml', content: generateCloudflareDeployYml() })
  }

  const results: PushResult[] = []
  for (const { name, content } of files) {
    const status = await pushWorkflowFile(owner, repo, `.github/workflows/${name}`, content, {
      branch,
      skipExisting: !force,
    })
    results.push({ file: name, status })
  }
  return results
}

/** Push a specific subset of workflow files (e.g. only the generic ones).
 *  Same top-up default as pushWorkflows: existing files are skipped unless `force`. */
export async function pushGenericWorkflows(
  owner: string,
  repo: string,
  branch: string,
  force = false,
): Promise<PushResult[]> {
  const files = [
    { name: 'auto-merge.yml', content: generateAutoMergeYml() },
    { name: 'pr-title.yml', content: generatePrTitleYml() },
    { name: 'context-lint.yml', content: generateContextLintYml() },
  ]
  const results: PushResult[] = []
  for (const { name, content } of files) {
    const status = await pushWorkflowFile(owner, repo, `.github/workflows/${name}`, content, {
      branch,
      skipExisting: !force,
    })
    results.push({ file: name, status })
  }
  return results
}

/** Write workflow files to the local filesystem (legacy / offline use). */
export async function writeWorkflows(opts: WorkflowOpts): Promise<string[]> {
  const fs = require('node:fs')
  const dir = '.github/workflows'
  fs.mkdirSync(dir, { recursive: true })
  const o = normalizeWorkflowOpts(opts)
  const written: string[] = []

  fs.writeFileSync(`${dir}/ci.yml`, generateCiYml(o))
  written.push('ci.yml')

  if (o.merge === 'merge-on-green') {
    fs.writeFileSync(`${dir}/merge-on-green.yml`, generateMergeOnGreenYml(o))
    written.push('merge-on-green.yml')
  } else {
    fs.writeFileSync(`${dir}/auto-merge.yml`, generateAutoMergeYml())
    written.push('auto-merge.yml')
  }

  fs.writeFileSync(`${dir}/secret-scan.yml`, generateSecretScanYml())
  written.push('secret-scan.yml')

  fs.writeFileSync(`${dir}/pr-title.yml`, generatePrTitleYml())
  written.push('pr-title.yml')

  fs.writeFileSync(`${dir}/context-lint.yml`, generateContextLintYml())
  written.push('context-lint.yml')

  fs.writeFileSync(`${dir}/dependabot-automerge.yml`, generateDependabotAutomergeYml())
  written.push('dependabot-automerge.yml')

  fs.mkdirSync('.github', { recursive: true })
  fs.writeFileSync('.github/dependabot.yml', generateDependabotYml())

  if (o.deploy === 'vercel') {
    fs.writeFileSync(`${dir}/deploy-preview.yml`, generateDeployYml(o))
    written.push('deploy-preview.yml')
  }
  if (o.deploy === 'cloudflare') {
    fs.writeFileSync(`${dir}/deploy-cloudflare.yml`, generateCloudflareDeployYml())
    written.push('deploy-cloudflare.yml')
  }

  return written
}

/** Build WorkflowOpts from stack.yml-shaped fields (ci-setup / checkup drift). */
export function workflowOptsFromStack(stack: {
  runtime?: string
  test?: string
  deployPlatform?: string
  e2e?: string
  commands?: { lint?: string; typecheck?: string; test?: string }
  merge?: 'auto-merge' | 'merge-on-green'
}): WorkflowOpts {
  const runtime = (stack.runtime ?? 'bun') as WorkflowOpts['stack']
  const testRaw = stack.test ?? stack.commands?.test ?? 'none'
  let test: WorkflowOpts['test'] = 'none'
  if (/vitest/i.test(testRaw)) test = 'vitest'
  else if (/jest/i.test(testRaw)) test = 'jest'
  else if (/pytest/i.test(testRaw)) test = 'pytest'
  let deploy: WorkflowOpts['deploy'] = 'none'
  const platform = stack.deployPlatform ?? ''
  if (platform === 'vercel') deploy = 'vercel'
  else if (platform.startsWith('cloudflare')) deploy = 'cloudflare'
  return normalizeWorkflowOpts({
    stack: runtime === 'python' || runtime === 'node' ? runtime : 'bun',
    test,
    deploy,
    merge: stack.merge,
    e2e: stack.e2e === 'playwright' ? 'playwright' : 'none',
    lint: Boolean(stack.commands?.lint),
    typecheck: Boolean(stack.commands?.typecheck),
  })
}
