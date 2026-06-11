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
          detail:
            'secret-scan.yml present but trufflehog missing from required checks — run /init to fix (enforcement gate; workflow-content presence is the Security section check)',
        })
      }
    }
  }
  return { name: 'Branch protection', checks }
}

/**
 * Repo metadata fetched once per doctor run and threaded into every check that
 * needs it — checkSecretScanning, checkRulesets, checkCIPermissions previously
 * each hit `repos/{owner}/{repo}` independently (3 calls to the same resource).
 */
export interface RepoMeta {
  visibility: string
  defaultBranch: string
  secretScanning: string
  pushProtection: string
}

export function fetchRepoMeta(ghOk: boolean, owner: string, repo: string): RepoMeta | null {
  if (!ghOk || !owner || !repo) return null
  const r = spawnSync(['gh', 'api', `repos/${owner}/${repo}`])
  if (!r.ok) return null
  try {
    const j = JSON.parse(r.stdout)
    return {
      visibility: j.visibility ?? '',
      defaultBranch: j.default_branch ?? '',
      secretScanning: j.security_and_analysis?.secret_scanning?.status ?? 'unavailable',
      pushProtection: j.security_and_analysis?.secret_scanning_push_protection?.status ?? 'unavailable',
    }
  } catch {
    return null
  }
}

export function checkRulesets(ghOk: boolean, owner: string, repo: string, meta: RepoMeta | null): Section {
  if (!ghOk || !owner || !repo)
    return {
      name: 'Rulesets',
      checks: [{ name: DEFAULT_RULESET.name, status: 'skip', detail: 'gh CLI not available' }],
    }

  // Single list fetch, parsed as JSON and filtered client-side — no value
  // interpolation into a jq program (injection-shaped even with constants).
  const result = spawnSync(['gh', 'api', `repos/${owner}/${repo}/rulesets`])
  if (!result.ok)
    return {
      name: 'Rulesets',
      checks: [{ name: DEFAULT_RULESET.name, status: 'warn', detail: 'could not fetch rulesets' }],
    }

  let rulesets: Array<{ id?: number; name?: string }> = []
  try {
    const parsed = JSON.parse(result.stdout)
    if (Array.isArray(parsed)) rulesets = parsed
  } catch {
    return {
      name: 'Rulesets',
      checks: [{ name: DEFAULT_RULESET.name, status: 'warn', detail: 'unexpected rulesets API response' }],
    }
  }

  const ruleset = rulesets.find((r) => r.name === DEFAULT_RULESET.name)

  const checks: Check[] = [
    {
      name: DEFAULT_RULESET.name,
      status: ruleset ? 'pass' : 'warn',
      detail: ruleset ? 'active' : 'missing — run /init to create (enforces squash/rebase/merge, thread resolution)',
    },
  ]

  // One detail fetch by id covers both merge methods and targeted refs
  if (ruleset && typeof ruleset.id === 'number') {
    const detailResult = spawnSync(['gh', 'api', `repos/${owner}/${repo}/rulesets/${ruleset.id}`])
    let detail: {
      rules?: Array<{ type?: string; parameters?: { allowed_merge_methods?: string[] } }>
      conditions?: { ref_name?: { include?: string[] } }
    } | null = null
    if (detailResult.ok) {
      try {
        detail = JSON.parse(detailResult.stdout)
      } catch {}
    }

    if (detail) {
      const prRule = detail.rules?.find((rule) => rule.type === 'pull_request')
      const methods = prRule?.parameters?.allowed_merge_methods ?? []
      const hasMerge = methods.includes('merge')
      checks.push({
        name: 'Merge commit allowed',
        status: hasMerge ? 'pass' : 'warn',
        detail: hasMerge
          ? 'merge commit enabled (required for promotion PRs)'
          : 'merge commit not in allowed_merge_methods — promotion PRs will cause history divergence',
      })

      // A ruleset pinned to refs/heads/main protects nothing on repos whose default
      // branch is staging — the ruleset reports "active" while every PR merges unchecked.
      const defaultBranch = meta?.defaultBranch ?? ''
      if (defaultBranch) {
        const targets = detail.conditions?.ref_name?.include ?? []
        const coversDefault =
          targets.includes('~DEFAULT_BRANCH') ||
          targets.includes('~ALL') ||
          targets.includes(`refs/heads/${defaultBranch}`)
        const hasGlob = targets.some((t) => t.includes('*'))
        let status: Status = 'pass'
        let detailMsg = `covers default branch (${defaultBranch})`
        if (!coversDefault) {
          status = 'warn'
          detailMsg = hasGlob
            ? `targets [${targets.join(', ')}] — glob pattern, cannot statically verify coverage of ${defaultBranch}; review manually`
            : `targets [${targets.join(', ')}] but default branch is ${defaultBranch} — default branch unprotected. Retarget to ~DEFAULT_BRANCH (see Fix table)`
        }
        checks.push({ name: 'Default branch targeted', status, detail: detailMsg })
      }
    }
  }

  return { name: 'Rulesets', checks }
}

export function checkSecretScanning(ghOk: boolean, meta: RepoMeta | null): Section {
  if (!ghOk)
    return {
      name: 'Secret scanning',
      checks: [{ name: 'secret scanning', status: 'skip', detail: 'gh CLI not available' }],
    }
  if (!meta)
    return {
      name: 'Secret scanning',
      checks: [{ name: 'secret scanning', status: 'warn', detail: 'could not fetch repo settings' }],
    }

  // Private repos need GH Advanced Security (paid) — not actionable on free plans
  if (meta.visibility !== 'public' && meta.secretScanning === 'unavailable')
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
        status: meta.secretScanning === 'enabled' ? 'pass' : 'fail',
        detail:
          meta.secretScanning === 'enabled' ? 'enabled' : 'disabled — free for public repos, see Fix table to enable',
      },
      {
        name: 'push protection',
        status: meta.pushProtection === 'enabled' ? 'pass' : 'fail',
        detail:
          meta.pushProtection === 'enabled' ? 'enabled' : 'disabled — blocks pushes containing live secrets, same fix',
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

  const r = spawnSync(['gh', 'api', `repos/${owner}/${repo}/actions/permissions/workflow`])
  if (!r.ok)
    return {
      name: 'Actions token',
      checks: [
        {
          name: 'default permissions',
          status: 'warn',
          detail:
            'could not fetch Actions settings — network error or token scope (fine-grained PAT needs Administration:read, classic PAT needs repo)',
        },
      ],
    }

  let settings: { default_workflow_permissions?: string; can_approve_pull_request_reviews?: boolean }
  try {
    settings = JSON.parse(r.stdout)
  } catch {
    return {
      name: 'Actions token',
      checks: [{ name: 'default permissions', status: 'warn', detail: 'unexpected Actions API response' }],
    }
  }
  const perms = settings.default_workflow_permissions ?? ''
  const canApprove = settings.can_approve_pull_request_reviews === true
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
        status: canApprove ? 'warn' : 'pass',
        detail: canApprove
          ? 'GITHUB_TOKEN can approve PRs — a compromised workflow can self-approve. Disable unless required.'
          : 'disabled',
      },
    ],
  }
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

export function checkCIPermissions(meta: RepoMeta | null): Section {
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

  const isPrivate = meta?.visibility === 'private'

  const issues: Array<{ file: string; job: string; permissions: string[] }> = []
  for (const filePath of files) {
    let content: string
    try {
      content = readFileSync(filePath, 'utf8') as string
    } catch {
      checks.push({ name: filePath, status: 'warn', detail: 'could not read file — skipped' })
      continue
    }
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
