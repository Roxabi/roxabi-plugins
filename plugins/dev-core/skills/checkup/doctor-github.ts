/**
 * GitHub-related health checks for the doctor CLI.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import {
  DEFAULT_RULESET,
  PROTECTED_BRANCHES,
  REQUIRED_SECRETS,
  STANDARD_LABELS,
  STANDARD_WORKFLOWS,
} from '../shared/adapters/github-infra'
import { type Check, readConfig, readStackYml, type Section, type Status, spawnSync } from './doctor-shared'

export function checkGitHubConfig(ghOk: boolean, owner: string, repo: string): Section {
  const skip = (name: string) => ({ name, status: 'skip' as Status, detail: 'gh CLI not available' })
  if (!ghOk)
    return {
      name: 'GitHub',
      checks: ['GITHUB_REPO', 'GITHUB_TOKEN', 'GH_PROJECT_ID', 'Status field', 'Size field', 'Priority field'].map(
        skip,
      ),
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

  // GH_PROJECT_ID
  const projectId = env.GH_PROJECT_ID
  if (projectId) {
    const projects = spawnSync(['gh', 'project', 'list', '--owner', owner, '--format', 'json', '--limit', '20'])
    let verified = false
    if (projects.ok) {
      try {
        const data = JSON.parse(projects.stdout) as { projects: { id: string }[] }
        verified = data.projects?.some((p) => p.id === projectId) ?? false
      } catch {}
    }
    checks.push({
      name: 'GH_PROJECT_ID',
      status: verified ? 'pass' : 'warn',
      detail: verified ? 'set (verified)' : 'set (not verified)',
    })
  } else {
    checks.push({ name: 'GH_PROJECT_ID', status: 'fail', detail: 'not set in .claude/dev-core.yml or .env' })
  }

  // Project linked to repo
  if (projectId && repo) {
    const linkQuery = `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        projectsV2(first: 20) { nodes { id } }
      }
    }`
    const linkResult = spawnSync([
      'gh',
      'api',
      'graphql',
      '-f',
      `query=${linkQuery}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${repo}`,
    ])
    let linked = false
    if (linkResult.ok) {
      try {
        const linkData = JSON.parse(linkResult.stdout) as {
          data: { repository: { projectsV2: { nodes: { id: string }[] } } }
        }
        linked = linkData.data.repository.projectsV2.nodes.some((p) => p.id === projectId)
      } catch {}
    }
    checks.push({
      name: 'Project linked to repo',
      status: linked ? 'pass' : 'warn',
      detail: linked
        ? 'project is linked to repository'
        : `project not linked — fix: gh api graphql -f query='mutation { linkProjectV2ToRepository(input: { projectId: "${projectId}", repositoryId: "REPO_NODE_ID" }) { repository { id } } }'`,
    })
  }

  // Field IDs
  for (const field of ['STATUS_FIELD_ID', 'SIZE_FIELD_ID', 'PRIORITY_FIELD_ID']) {
    const label = `${field.replace('_FIELD_ID', '').replace('_', ' ')} field`
    const val = env[field]
    checks.push({
      name: label,
      status: val ? 'pass' : 'fail',
      detail: val ? 'configured' : 'not set in .claude/dev-core.yml or .env',
    })
  }

  return { name: 'GitHub', checks }
}

export function checkLabels(ghOk: boolean, owner: string, repo: string): Section {
  if (!ghOk) return { name: 'Labels', checks: [{ name: 'labels', status: 'skip', detail: 'gh CLI not available' }] }

  const result = spawnSync(['gh', 'label', 'list', '--repo', `${owner}/${repo}`, '--json', 'name', '--limit', '100'])
  if (!result.ok)
    return { name: 'Labels', checks: [{ name: 'labels', status: 'fail', detail: 'could not fetch labels' }] }

  let existing: string[] = []
  try {
    existing = (JSON.parse(result.stdout) as { name: string }[]).map((l) => l.name)
  } catch {}

  const missing = STANDARD_LABELS.filter((l) => !existing.includes(l.name)).map((l) => l.name)
  const count = STANDARD_LABELS.length - missing.length

  if (missing.length === 0) {
    return {
      name: 'Labels',
      checks: [
        { name: 'labels', status: 'pass', detail: `${STANDARD_LABELS.length}/${STANDARD_LABELS.length} present` },
      ],
    }
  }
  return {
    name: 'Labels',
    checks: [
      {
        name: 'labels',
        status: 'warn',
        detail: `${count}/${STANDARD_LABELS.length} present (missing: ${missing.join(', ')})`,
      },
    ],
  }
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

export function checkProjectWorkflows(ghOk: boolean, _owner: string): Section {
  if (!ghOk)
    return {
      name: 'Project workflows',
      checks: [{ name: 'workflows', status: 'skip', detail: 'gh CLI not available' }],
    }

  const config = readConfig()
  const projectId = config.GH_PROJECT_ID
  if (!projectId)
    return {
      name: 'Project workflows',
      checks: [{ name: 'workflows', status: 'skip', detail: 'GH_PROJECT_ID not set' }],
    }

  const query =
    'query($projectId: ID!) { node(id: $projectId) { ... on ProjectV2 { workflows(first: 20) { nodes { name enabled } } } } }'
  const result = spawnSync(['gh', 'api', 'graphql', '-f', `query=${query}`, '-F', `projectId=${projectId}`])
  if (!result.ok)
    return {
      name: 'Project workflows',
      checks: [{ name: 'workflows', status: 'warn', detail: 'could not fetch — check gh auth' }],
    }

  let nodes: Array<{ name: string; enabled: boolean }> = []
  try {
    const data = JSON.parse(result.stdout) as { data: { node: { workflows: { nodes: typeof nodes } } } }
    nodes = data.data.node.workflows.nodes
  } catch {
    return {
      name: 'Project workflows',
      checks: [{ name: 'workflows', status: 'warn', detail: 'could not parse response' }],
    }
  }

  const enabled = nodes.filter((w) => w.enabled).length
  const total = nodes.length
  const disabled = nodes.filter((w) => !w.enabled).map((w) => w.name)

  if (disabled.length === 0) {
    return {
      name: 'Project workflows',
      checks: [{ name: 'workflows', status: 'pass', detail: `${enabled}/${total} enabled` }],
    }
  }
  return {
    name: 'Project workflows',
    checks: [
      { name: 'workflows', status: 'warn', detail: `${enabled}/${total} enabled — disabled: ${disabled.join(', ')}` },
    ],
  }
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
  }

  return { name: 'Rulesets', checks }
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
