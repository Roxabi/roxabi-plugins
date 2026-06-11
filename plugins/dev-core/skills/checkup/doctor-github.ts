/**
 * GitHub-related health checks for the doctor CLI.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import {
  DEFAULT_RULESET,
  PROTECTED_BRANCHES,
  REQUIRED_SECRETS,
  STANDARD_WORKFLOWS,
} from '../shared/adapters/github-infra'
import { type Check, readConfig, readStackYml, type Section, type Status, spawnSync } from './doctor-shared'

export function checkGitHubConfig(ghOk: boolean, owner: string, repo: string): Section {
  const skip = (name: string) => ({ name, status: 'skip' as Status, detail: 'gh CLI not available' })
  if (!ghOk)
    return {
      name: 'GitHub',
      checks: ['GITHUB_REPO', 'GITHUB_TOKEN'].map(skip),
    }

  const env = readConfig()
  const checks: Check[] = []

  // GITHUB_REPO
  const ghRepo = env.GITHUB_REPO || (owner && repo ? `${owner}/${repo}` : '')
  checks.push({ name: 'GITHUB_REPO', status: ghRepo ? 'pass' : 'fail', detail: ghRepo || 'not set' })

  // GITHUB_TOKEN
  const hasToken = !!process.env.GITHUB_TOKEN || spawnSync(['gh', 'auth', 'token']).ok
  checks.push({
    name: 'GITHUB_TOKEN',
    status: hasToken ? 'pass' : 'fail',
    detail: hasToken ? 'available' : 'not set and gh auth token failed',
  })

  return { name: 'GitHub', checks }
}

export function checkWorkflows(ghOk: boolean, owner: string, repo: string): Section {
  const stack = readStackYml()
  const checks: Check[] = []

  // Fetch remote workflow list once (workflows may be pushed via REST API, not locally committed)
  const remoteFiles: Set<string> = new Set()
  if (ghOk && owner && repo) {
    const r = spawnSync(['gh', 'api', `/repos/${owner}/${repo}/contents/.github/workflows`, '--jq', '.[].name'])
    if (r.ok) {
      for (const line of r.stdout.split('\n')) {
        const f = line.trim()
        if (f) remoteFiles.add(f)
      }
    }
  }

  for (const wf of STANDARD_WORKFLOWS) {
    const localExists = existsSync(`.github/workflows/${wf}`)
    const remoteExists = remoteFiles.has(wf)
    const exists = localExists || remoteExists

    if (exists) {
      checks.push({ name: wf, status: 'pass', detail: localExists ? 'found locally' : 'found on remote' })
      continue
    }
    // deploy-preview.yml only matters when a deploy platform is configured
    if (wf === 'deploy-preview.yml' && !stack.hasDeployPlatform) {
      checks.push({ name: wf, status: 'skip', detail: 'skipped — no deploy platform in stack.yml' })
      continue
    }
    // CI/CD workflows are optional — always warn, never fail
    checks.push({ name: wf, status: 'warn', detail: 'missing — run /init to create' })
  }
  return { name: 'Workflows', checks }
}

export function checkSecrets(ghOk: boolean, owner: string, repo: string): Section {
  if (!ghOk || !owner || !repo)
    return { name: 'Secrets', checks: [{ name: 'secrets', status: 'skip', detail: 'gh CLI not available' }] }

  const checks: Check[] = []

  // Fetch remote workflow list to know which secrets are required
  const r = spawnSync(['gh', 'api', `/repos/${owner}/${repo}/contents/.github/workflows`, '--jq', '.[].name'])
  const remoteFiles: Set<string> = new Set()
  if (r.ok) {
    for (const line of r.stdout.split('\n')) {
      const f = line.trim()
      if (f) remoteFiles.add(f)
    }
  }

  // Also check local
  for (const wf of Object.keys(REQUIRED_SECRETS)) {
    if (!remoteFiles.has(wf) && !existsSync(`.github/workflows/${wf}`)) continue
    const secretName = REQUIRED_SECRETS[wf]
    const result = spawnSync(['gh', 'api', `/repos/${owner}/${repo}/actions/secrets/${secretName}`])
    checks.push({
      name: secretName,
      status: result.ok ? 'pass' : 'warn',
      detail: result.ok
        ? `set (required by ${wf})`
        : `missing — required by ${wf}. Fix: gh secret set ${secretName} --repo ${owner}/${repo} --body "$(gh auth token)"`,
    })
  }

  if (checks.length === 0)
    return {
      name: 'Secrets',
      checks: [{ name: 'secrets', status: 'skip', detail: 'no secrets required by current workflows' }],
    }

  return { name: 'Secrets', checks }
}

export function checkBranchProtection(ghOk: boolean, owner: string, repo: string): Section {
  if (!ghOk)
    return {
      name: 'Branch protection',
      checks: PROTECTED_BRANCHES.map((b) => ({ name: b, status: 'skip' as Status, detail: 'gh CLI not available' })),
    }

  const checks: Check[] = []
  const secretScanResult = spawnSync(['gh', 'api', `repos/${owner}/${repo}/contents/.github/workflows/secret-scan.yml`])
  const secretScanPresent = secretScanResult.ok
  for (const branch of PROTECTED_BRANCHES) {
    // Check branch exists before checking protection
    const branchExists = spawnSync(['gh', 'api', `repos/${owner}/${repo}/branches/${branch}`])
    if (!branchExists.ok) {
      checks.push({ name: branch, status: 'skip', detail: 'branch does not exist' })
      continue
    }
    const result = spawnSync([
      'gh',
      'api',
      `repos/${owner}/${repo}/branches/${branch}/protection`,
      '--jq',
      '.required_status_checks.contexts // []',
    ])
    checks.push({ name: branch, status: result.ok ? 'pass' : 'fail', detail: result.ok ? 'protected' : 'unprotected' })
    if (secretScanPresent && result.ok) {
      let contexts: string[] = []
      try {
        const parsed = JSON.parse(result.stdout || '[]')
        contexts = Array.isArray(parsed) ? parsed : []
      } catch {
        contexts = []
      }
      if (!contexts.includes('trufflehog')) {
        checks.push({
          name: `${branch}:trufflehog-context`,
          status: 'warn',
          detail: 'secret-scan.yml present but trufflehog missing from required checks — run /init to fix',
        })
      }
    }
  }
  return { name: 'Branch protection', checks }
}

export function checkRulesets(ghOk: boolean, owner: string, repo: string): Section {
  if (!ghOk || !owner || !repo)
    return {
      name: 'Rulesets',
      checks: [{ name: DEFAULT_RULESET.name, status: 'skip', detail: 'gh CLI not available' }],
    }

  const result = spawnSync(['gh', 'api', `repos/${owner}/${repo}/rulesets`, '--jq', '.[].name'])
  if (!result.ok)
    return {
      name: 'Rulesets',
      checks: [{ name: DEFAULT_RULESET.name, status: 'warn', detail: 'could not fetch rulesets' }],
    }

  const existing = result.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => n)
  const hasRuleset = existing.includes(DEFAULT_RULESET.name)

  const checks: Check[] = [
    {
      name: DEFAULT_RULESET.name,
      status: hasRuleset ? 'pass' : 'warn',
      detail: hasRuleset ? 'active' : 'missing — run /init to create (enforces squash/rebase/merge, thread resolution)',
    },
  ]

  // Check that merge commit is in allowed methods (needed for promotion PRs)
  if (hasRuleset) {
    const detailResult = spawnSync([
      'gh',
      'api',
      `repos/${owner}/${repo}/rulesets`,
      '--jq',
      `.[] | select(.name == "${DEFAULT_RULESET.name}") | .rules[] | select(.type == "pull_request") | .parameters.allowed_merge_methods`,
    ])
    if (detailResult.ok) {
      const methods = detailResult.stdout.trim()
      const hasMerge = methods.includes('merge')
      checks.push({
        name: 'Merge commit allowed',
        status: hasMerge ? 'pass' : 'warn',
        detail: hasMerge
          ? 'merge commit enabled (required for promotion PRs)'
          : 'merge commit not in allowed_merge_methods — promotion PRs will cause history divergence',
      })
    }

    // A ruleset pinned to refs/heads/main protects nothing on repos whose default
    // branch is staging — the ruleset reports "active" while every PR merges unchecked.
    const idResult = spawnSync([
      'gh',
      'api',
      `repos/${owner}/${repo}/rulesets`,
      '--jq',
      `[.[] | select(.name == "${DEFAULT_RULESET.name}") | .id] | first`,
    ])
    const defaultBranchResult = spawnSync(['gh', 'api', `repos/${owner}/${repo}`, '--jq', '.default_branch'])
    const rulesetId = idResult.ok ? idResult.stdout.trim() : ''
    const defaultBranch = defaultBranchResult.ok ? defaultBranchResult.stdout.trim() : ''
    if (rulesetId && defaultBranch) {
      const condResult = spawnSync([
        'gh',
        'api',
        `repos/${owner}/${repo}/rulesets/${rulesetId}`,
        '--jq',
        '.conditions.ref_name.include // [] | join(",")',
      ])
      if (condResult.ok) {
        const targets = condResult.stdout
          .trim()
          .split(',')
          .filter((t) => t)
        const coversDefault =
          targets.includes('~DEFAULT_BRANCH') ||
          targets.includes('~ALL') ||
          targets.includes(`refs/heads/${defaultBranch}`)
        checks.push({
          name: 'Default branch targeted',
          status: coversDefault ? 'pass' : 'warn',
          detail: coversDefault
            ? `covers default branch (${defaultBranch})`
            : `targets [${targets.join(', ')}] but default branch is ${defaultBranch} — default branch unprotected. Retarget to ~DEFAULT_BRANCH via gh api repos/${owner}/${repo}/rulesets/${rulesetId} --method PUT`,
        })
      }
    }
  }

  return { name: 'Rulesets', checks }
}

export function checkSecretScanning(ghOk: boolean, owner: string, repo: string): Section {
  if (!ghOk || !owner || !repo)
    return {
      name: 'Secret scanning',
      checks: [{ name: 'secret scanning', status: 'skip', detail: 'gh CLI not available' }],
    }

  const r = spawnSync([
    'gh',
    'api',
    `repos/${owner}/${repo}`,
    '--jq',
    '[.visibility, (.security_and_analysis.secret_scanning.status // "unavailable"), (.security_and_analysis.secret_scanning_push_protection.status // "unavailable")] | join("|")',
  ])
  if (!r.ok)
    return {
      name: 'Secret scanning',
      checks: [{ name: 'secret scanning', status: 'warn', detail: 'could not fetch repo settings' }],
    }

  const [visibility, scanning, pushProtection] = r.stdout.trim().split('|')

  // Private repos need GH Advanced Security (paid) — not actionable on free plans
  if (visibility !== 'public' && scanning === 'unavailable')
    return {
      name: 'Secret scanning',
      checks: [
        { name: 'secret scanning', status: 'skip', detail: 'unavailable — private repo without GH Advanced Security' },
      ],
    }

  return {
    name: 'Secret scanning',
    checks: [
      {
        name: 'secret scanning',
        status: scanning === 'enabled' ? 'pass' : 'fail',
        detail: scanning === 'enabled' ? 'enabled' : 'disabled — free for public repos, see Fix table to enable',
      },
      {
        name: 'push protection',
        status: pushProtection === 'enabled' ? 'pass' : 'fail',
        detail: pushProtection === 'enabled' ? 'enabled' : 'disabled — blocks pushes containing live secrets, same fix',
      },
    ],
  }
}

export function checkDefaultWorkflowPermissions(ghOk: boolean, owner: string, repo: string): Section {
  if (!ghOk || !owner || !repo)
    return {
      name: 'Actions token',
      checks: [{ name: 'default permissions', status: 'skip', detail: 'gh CLI not available' }],
    }

  const r = spawnSync([
    'gh',
    'api',
    `repos/${owner}/${repo}/actions/permissions/workflow`,
    '--jq',
    '[.default_workflow_permissions, (.can_approve_pull_request_reviews | tostring)] | join("|")',
  ])
  if (!r.ok)
    return {
      name: 'Actions token',
      checks: [{ name: 'default permissions', status: 'warn', detail: 'could not fetch Actions settings' }],
    }

  const [perms, canApprove] = r.stdout.trim().split('|')
  return {
    name: 'Actions token',
    checks: [
      {
        name: 'default permissions',
        status: perms === 'read' ? 'pass' : 'warn',
        detail:
          perms === 'read'
            ? 'read-only'
            : `${perms} — workflows without a permissions: block get a write token. Fix: gh api repos/${owner}/${repo}/actions/permissions/workflow --method PUT -f default_workflow_permissions=read`,
      },
      {
        name: 'can approve PRs',
        status: canApprove === 'false' ? 'pass' : 'warn',
        detail:
          canApprove === 'false'
            ? 'disabled'
            : 'GITHUB_TOKEN can approve PRs — a compromised workflow can self-approve. Disable unless required.',
      },
    ],
  }
}

export interface PrTargetFinding {
  file: string
  checkout: 'none' | 'default' | 'pr-head'
}

/**
 * Detect the pull_request_target footgun: the trigger runs with secrets and a
 * write token on the BASE repo, so checking out (and executing) PR-head code
 * hands both to the PR author. Checkout of the default ref is suspicious but
 * survivable; an explicit PR-head ref is not.
 */
export function detectPullRequestTargetCheckout(content: string, filePath: string): PrTargetFinding | null {
  const hasTrigger =
    /^\s*pull_request_target\s*:/m.test(content) || /^on\s*:\s*\[[^\]]*pull_request_target[^\]]*\]/m.test(content)
  if (!hasTrigger) return null
  if (!content.includes('actions/checkout')) return { file: filePath, checkout: 'none' }
  const prHeadRef = /ref:\s*\$\{\{\s*github\.(event\.pull_request\.head\.(sha|ref)|head_ref)\s*\}\}/.test(content)
  return { file: filePath, checkout: prHeadRef ? 'pr-head' : 'default' }
}

export function checkPullRequestTarget(): Section {
  const wfDir = '.github/workflows'
  if (!existsSync(wfDir))
    return {
      name: 'pull_request_target',
      checks: [{ name: 'pull_request_target', status: 'skip', detail: 'no local workflow files found' }],
    }

  const checks: Check[] = []
  for (const f of readdirSync(wfDir) as string[]) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue
    const finding = detectPullRequestTargetCheckout(readFileSync(`${wfDir}/${f}`, 'utf8') as string, f)
    if (!finding) continue
    if (finding.checkout === 'pr-head') {
      checks.push({
        name: f,
        status: 'fail',
        detail:
          'pull_request_target checks out PR-head code — untrusted code runs with secrets + write token. Switch to pull_request or drop the PR-head ref.',
      })
    } else if (finding.checkout === 'default') {
      checks.push({
        name: f,
        status: 'warn',
        detail: 'pull_request_target + checkout (base ref) — safe only if PR-authored code is never executed; verify.',
      })
    } else {
      checks.push({ name: f, status: 'pass', detail: 'pull_request_target without checkout — API-only, safe' })
    }
  }
  if (checks.length === 0)
    checks.push({ name: 'pull_request_target', status: 'pass', detail: 'no workflow uses pull_request_target' })
  return { name: 'pull_request_target', checks }
}

/**
 * Parse a GitHub Actions workflow YAML text and find jobs that have a job-level
 * `permissions:` block with a `Checkout` step but are missing `contents: read`.
 * When a job defines its own permissions block it overrides top-level permissions,
 * so forgetting `contents: read` causes checkout to fail on private repos.
 */
export function detectMissingContentsRead(
  content: string,
  filePath: string,
): Array<{ file: string; job: string; permissions: string[] }> {
  const lines = content.split('\n')
  const issues: Array<{ file: string; job: string; permissions: string[] }> = []

  // Find jobs: section (at root indent)
  let jobsSectionLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^jobs:\s*$/.test(lines[i])) {
      jobsSectionLine = i
      break
    }
  }
  if (jobsSectionLine === -1) return issues

  // Find job headers (2-space indent within jobs section)
  const jobHeaders: Array<{ name: string; start: number }> = []
  for (let i = jobsSectionLine + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}([a-zA-Z0-9][a-zA-Z0-9_-]*):\s*$/)
    if (m) {
      jobHeaders.push({ name: m[1], start: i })
    } else if (/^\S/.test(lines[i]) && lines[i].trim() && !lines[i].trimStart().startsWith('#')) {
      break // top-level key — end of jobs section
    }
  }

  for (let j = 0; j < jobHeaders.length; j++) {
    const { name, start } = jobHeaders[j]
    const end = j + 1 < jobHeaders.length ? jobHeaders[j + 1].start : lines.length
    const jobLines = lines.slice(start + 1, end)

    let inPermissions = false
    let hasJobLevelPerms = false
    const permKeys: string[] = []
    let hasContentsRead = false
    let hasCheckout = false

    for (const line of jobLines) {
      // Job-level permissions block (4-space indent)
      const permLineMatch = line.match(/^ {4}permissions:\s*(.*)$/)
      if (permLineMatch) {
        const val = permLineMatch[1].trim()
        hasJobLevelPerms = true
        if (val === 'read-all' || val === 'write-all') {
          // These shorthand values include contents: read — no issue
          hasContentsRead = true
        } else {
          inPermissions = true
        }
        continue
      }

      if (inPermissions) {
        const permEntryMatch = line.match(/^ {6}([a-zA-Z-]+):\s*\S/)
        if (permEntryMatch) {
          permKeys.push(permEntryMatch[1])
          if (permEntryMatch[1] === 'contents') hasContentsRead = true
        } else if (line.trim() && !/^ {6}/.test(line)) {
          inPermissions = false
        }
      }

      if (line.includes('actions/checkout')) hasCheckout = true
    }

    if (hasJobLevelPerms && !hasContentsRead && hasCheckout) {
      issues.push({ file: filePath, job: name, permissions: [...permKeys] })
    }
  }

  return issues
}

export function checkCIPermissions(ghOk: boolean, owner: string, repo: string): Section {
  const checks: Check[] = []

  const wfDir = '.github/workflows'
  const files: string[] = []
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir) as string[]) {
      if (f.endsWith('.yml') || f.endsWith('.yaml')) {
        files.push(`${wfDir}/${f}`)
      }
    }
  }

  if (files.length === 0) {
    return {
      name: 'CI permissions',
      checks: [{ name: 'job permissions', status: 'skip', detail: 'no local workflow files found' }],
    }
  }

  let isPrivate = false
  if (ghOk && owner && repo) {
    const r = spawnSync(['gh', 'repo', 'view', `${owner}/${repo}`, '--json', 'isPrivate', '--jq', '.isPrivate'])
    isPrivate = r.stdout === 'true'
  }

  const issues: Array<{ file: string; job: string; permissions: string[] }> = []
  for (const filePath of files) {
    const content = readFileSync(filePath, 'utf8') as string
    issues.push(...detectMissingContentsRead(content, filePath))
  }

  if (issues.length === 0) {
    checks.push({
      name: 'job permissions',
      status: 'pass',
      detail: `${files.length} workflow(s) checked — no missing contents: read`,
    })
  } else {
    for (const issue of issues) {
      const fileName = issue.file.replace('.github/workflows/', '')
      const permList = issue.permissions.length > 0 ? `[${issue.permissions.join(', ')}]` : 'empty block'
      checks.push({
        name: `${fileName} / ${issue.job}`,
        status: isPrivate ? 'fail' : 'warn',
        detail: `job-level permissions missing \`contents: read\` — checkout fails on private repos. Current: ${permList}. Add \`contents: read\`.`,
      })
    }
  }

  return { name: 'CI permissions', checks }
}
