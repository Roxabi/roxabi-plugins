#!/usr/bin/env bun
/**
 * Doctor CLI — standalone health check for dev-core configuration.
 * Outputs formatted report (default) or JSON (--json).
 * Exit code: 0 = all pass, 1 = any failure.
 */

import {
  DEFAULT_RULESET,
  PROTECTED_BRANCHES,
  REQUIRED_SECRETS,
  STANDARD_LABELS,
  STANDARD_WORKFLOWS,
} from '../shared/adapters/github-infra'
import { checkPrereqs, type PrereqResult } from '../shared/prereqs'

// --- Types ---

type Status = 'pass' | 'fail' | 'warn' | 'skip'

interface Check {
  name: string
  status: Status
  detail: string
}

interface Section {
  name: string
  checks: Check[]
}

// --- Helpers ---

function spawnSync(cmd: string[]): { stdout: string; ok: boolean } {
  try {
    const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'pipe' })
    return { stdout: new TextDecoder().decode(proc.stdout).trim(), ok: proc.exitCode === 0 }
  } catch {
    return { stdout: '', ok: false }
  }
}

/** Read .claude/dev-core.yml and return a map of YAML keys to values (uppercase keys for compat). */
function readDevCoreYml(): Record<string, string> {
  try {
    const text = require('node:fs').readFileSync('.claude/dev-core.yml', 'utf8') as string
    const config: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const match = trimmed.match(/^(\w+):\s*['"]?(.+?)['"]?\s*$/)
      if (match) {
        const [, key, value] = match
        // Store under both YAML key and uppercase env-style key for lookup compat
        config[key] = value
        config[key.toUpperCase()] = value
      }
    }
    return config
  } catch {
    return {}
  }
}

function readEnvFile(): Record<string, string> {
  try {
    const text = require('node:fs').readFileSync('.env', 'utf8') as string
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq > 0) env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
    return env
  } catch {
    return {}
  }
}

/** Read config with 3-tier fallback: dev-core.yml → .env → empty. */
function readConfig(): Record<string, string> {
  const yml = readDevCoreYml()
  const env = readEnvFile()
  // dev-core.yml takes precedence, env fills gaps
  return { ...env, ...yml }
}

// --- Phase functions ---

function checkPrereqsSection(prereqs: PrereqResult): Section {
  return {
    name: 'Prerequisites',
    checks: [
      {
        name: 'bun',
        status: prereqs.bun.ok ? 'pass' : 'fail',
        detail: prereqs.bun.ok ? prereqs.bun.version : 'not installed — https://bun.sh/',
      },
      {
        name: 'gh',
        status: prereqs.gh.ok ? 'pass' : 'fail',
        detail: prereqs.gh.ok ? prereqs.gh.detail : `${prereqs.gh.detail} — https://cli.github.com/`,
      },
      {
        name: 'git remote',
        status: prereqs.gitRemote.ok ? 'pass' : 'fail',
        detail: prereqs.gitRemote.ok ? prereqs.gitRemote.url : 'no origin remote configured',
      },
    ],
  }
}

function checkGitHubConfig(ghOk: boolean, owner: string, repo: string): Section {
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

function checkLabels(ghOk: boolean, owner: string, repo: string): Section {
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

function readStackYml(): { hasDeployPlatform: boolean; hasFrontend: boolean } {
  try {
    const text = require('node:fs').readFileSync('.claude/stack.yml', 'utf8') as string
    // deploy.platform: none means no deploy platform
    const platformMatch = text.match(/^\s*platform:\s*(\S+)/m)
    const hasDeployPlatform = !!platformMatch && platformMatch[1] !== 'none'
    // frontend section present with a real framework
    const frontendMatch = text.match(/^frontend:/m)
    const frameworkMatch = text.match(/^\s+framework:\s*(\S+)/m)
    const hasFrontend = !!frontendMatch && !!frameworkMatch && frameworkMatch[1] !== 'none'
    return { hasDeployPlatform, hasFrontend }
  } catch {
    return { hasDeployPlatform: true, hasFrontend: true } // unknown — keep checks strict
  }
}

function checkWorkflows(ghOk: boolean, owner: string, repo: string): Section {
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
    const localExists = require('node:fs').existsSync(`.github/workflows/${wf}`)
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

function checkSecrets(ghOk: boolean, owner: string, repo: string): Section {
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
    if (!remoteFiles.has(wf) && !require('node:fs').existsSync(`.github/workflows/${wf}`)) continue
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

function checkProjectWorkflows(ghOk: boolean, _owner: string): Section {
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

function checkBranchProtection(ghOk: boolean, owner: string, repo: string): Section {
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
    const result = spawnSync(['gh', 'api', `repos/${owner}/${repo}/branches/${branch}/protection`])
    checks.push({ name: branch, status: result.ok ? 'pass' : 'fail', detail: result.ok ? 'protected' : 'unprotected' })
    if (secretScanPresent && result.ok) {
      const contextsResult = spawnSync([
        'gh',
        'api',
        `repos/${owner}/${repo}/branches/${branch}/protection`,
        '--jq',
        '.required_status_checks.contexts // []',
      ])
      if (contextsResult.ok) {
        let contexts: string[] = []
        try {
          contexts = JSON.parse(contextsResult.stdout || '[]')
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
  }
  return { name: 'Branch protection', checks }
}

function checkRulesets(ghOk: boolean, owner: string, repo: string): Section {
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

function checkProjectStructure(): Section {
  const checks: Check[] = []

  // .claude/dev-core.yml (primary config)
  const devCoreYmlExists = require('node:fs').existsSync('.claude/dev-core.yml')
  checks.push({
    name: 'dev-core.yml',
    status: devCoreYmlExists ? 'pass' : 'warn',
    detail: devCoreYmlExists
      ? 'found (.claude/dev-core.yml)'
      : 'missing — config read from .env fallback. Run /init to generate.',
  })

  // .env (legacy fallback)
  const envExists = require('node:fs').existsSync('.env')
  checks.push({
    name: '.env',
    status: envExists ? 'pass' : devCoreYmlExists ? 'skip' : 'fail',
    detail: envExists ? 'found' : devCoreYmlExists ? 'not needed (dev-core.yml present)' : 'missing',
  })

  // artifacts/
  const artifactDirs = ['frames', 'analyses', 'specs', 'plans']
  const allExist = artifactDirs.every((d) => require('node:fs').existsSync(`artifacts/${d}`))
  checks.push({
    name: 'artifacts/',
    status: allExist ? 'pass' : 'fail',
    detail: allExist ? 'found' : 'missing subdirectories',
  })

  // roxabi shim + PATH
  const home = require('node:os').homedir()
  const shimPaths = [`${home}/.local/bin/roxabi`, `${home}/bin/roxabi`]
  const inPath = spawnSync(['sh', '-c', 'command -v roxabi']).ok
  const shimFile = shimPaths.find((p) => require('node:fs').existsSync(p))
  if (inPath) {
    checks.push({ name: 'roxabi CLI', status: 'pass', detail: 'in PATH' })
  } else if (shimFile) {
    const shimDir = shimFile.substring(0, shimFile.lastIndexOf('/'))
    checks.push({
      name: 'roxabi CLI',
      status: 'warn',
      detail: `shim exists but not in PATH — add: export PATH="${shimDir.replace(home, '$HOME')}:$PATH"`,
    })
  } else {
    checks.push({ name: 'roxabi CLI', status: 'warn', detail: 'not found — run /init to install' })
  }

  return { name: 'Project', checks }
}

function checkSecurity(): Section {
  const checks: Check[] = []
  const fs = require('node:fs')

  // trufflehog binary
  const trufflehogInstalled = spawnSync(['which', 'trufflehog']).ok
  checks.push({
    name: 'trufflehog',
    status: trufflehogInstalled ? 'pass' : 'warn',
    detail: trufflehogInstalled
      ? 'installed'
      : 'not installed — pre-commit hook will fail. Install: brew install trufflehog or https://github.com/trufflesecurity/trufflehog/releases',
  })

  // .github/dependabot.yml
  const dependabotExists = fs.existsSync('.github/dependabot.yml')
  checks.push({
    name: 'dependabot.yml',
    status: dependabotExists ? 'pass' : 'warn',
    detail: dependabotExists ? 'found' : 'missing — run /init to create (automated dependency updates)',
  })

  // lock file + license checker — inferred from stack.yml package_manager
  let lockFile: string | null = null
  let licenseChecker: string | null = null
  let pm = ''
  try {
    const stack = fs.readFileSync('.claude/stack.yml', 'utf8') as string
    const pmMatch = stack.match(/^\s*package_manager:\s*(\S+)/m)
    pm = pmMatch?.[1] ?? ''
    if (pm === 'uv' || pm === 'pip') {
      lockFile = 'uv.lock'
      licenseChecker = 'tools/license_check.py'
    } else if (pm === 'bun') {
      lockFile = 'bun.lock'
      licenseChecker = 'tools/licenseChecker.ts'
    } else if (pm === 'npm') {
      lockFile = 'package-lock.json'
      licenseChecker = 'tools/licenseChecker.ts'
    } else if (pm === 'pnpm') {
      lockFile = 'pnpm-lock.yaml'
      licenseChecker = 'tools/licenseChecker.ts'
    } else if (pm === 'yarn') {
      lockFile = 'yarn.lock'
      licenseChecker = 'tools/licenseChecker.ts'
    }
  } catch {}

  if (lockFile) {
    const lockExists = fs.existsSync(lockFile)
    checks.push({
      name: lockFile,
      status: lockExists ? 'pass' : 'warn',
      detail: lockExists ? 'found' : `missing — commit ${lockFile} for reproducible installs`,
    })
  } else {
    checks.push({
      name: 'lock file',
      status: 'skip',
      detail: pm ? `unsupported package manager: ${pm}` : 'package_manager not set in stack.yml',
    })
  }

  // license checker script
  if (licenseChecker) {
    const licenseExists = fs.existsSync(licenseChecker)
    checks.push({
      name: licenseChecker,
      status: licenseExists ? 'pass' : 'warn',
      detail: licenseExists ? 'found' : 'missing — run /init to create license compliance checker',
    })
  } else {
    checks.push({
      name: 'license checker',
      status: 'skip',
      detail: pm ? `unsupported package manager: ${pm}` : 'package_manager not set in stack.yml',
    })
  }

  // trufflehog in lefthook (if lefthook.yml present)
  const lefthookPath = 'lefthook.yml'
  if (fs.existsSync(lefthookPath)) {
    const lefthookContent = fs.readFileSync(lefthookPath, 'utf8') as string
    const hasTrufflehog = lefthookContent.includes('trufflehog')
    checks.push({
      name: 'trufflehog in lefthook',
      status: hasTrufflehog ? 'pass' : 'warn',
      detail: hasTrufflehog ? 'configured in lefthook.yml' : 'not found in lefthook.yml — run /init to add',
    })
    const hasLicense = lefthookContent.includes('license')
    checks.push({
      name: 'license check in lefthook',
      status: hasLicense ? 'pass' : 'warn',
      detail: hasLicense ? 'configured in lefthook.yml' : 'not found in lefthook.yml — run /init to add',
    })
  }

  return { name: 'Security', checks }
}

function checkVercel(): Section {
  const checks: Check[] = []

  const vercelExists = require('node:fs').existsSync('.vercel/project.json')
  checks.push({
    name: '.vercel/project',
    status: vercelExists ? 'pass' : 'skip',
    detail: vercelExists ? 'found' : 'not found (optional)',
  })

  if (vercelExists) {
    const config = readConfig()
    const hasToken = !!process.env.VERCEL_TOKEN || !!config.VERCEL_TOKEN
    checks.push({ name: 'VERCEL_TOKEN', status: hasToken ? 'pass' : 'warn', detail: hasToken ? 'set' : 'not set' })
  }

  return { name: 'Vercel', checks }
}

// --- CI Permissions ---

/**
 * Parse a GitHub Actions workflow YAML text and find jobs that have a job-level
 * `permissions:` block with a `Checkout` step but are missing `contents: read`.
 * When a job defines its own permissions block it overrides top-level permissions,
 * so forgetting `contents: read` causes checkout to fail on private repos.
 */
function detectMissingContentsRead(
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

function checkCIPermissions(ghOk: boolean, owner: string, repo: string): Section {
  const fs = require('node:fs') as typeof import('fs')
  const checks: Check[] = []

  const wfDir = '.github/workflows'
  const files: string[] = []
  if (fs.existsSync(wfDir)) {
    for (const f of fs.readdirSync(wfDir) as string[]) {
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
    const content = fs.readFileSync(filePath, 'utf8') as string
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

function checkStandardsPaths(): Section {
  const fs = require('node:fs') as typeof import('fs')
  const checks: Check[] = []

  if (!fs.existsSync('.claude/stack.yml')) {
    return { name: 'Standards', checks: [{ name: 'stack.yml', status: 'skip', detail: 'not found' }] }
  }

  try {
    const raw = fs.readFileSync('.claude/stack.yml', 'utf8') as string
    const lines = raw.split('\n')
    let inStandards = false

    for (const line of lines) {
      if (/^standards:\s*$/.test(line)) {
        inStandards = true
        continue
      }
      if (inStandards) {
        if (/^\S/.test(line)) break // new top-level key
        const match = line.match(/^\s+(\w+):\s*(.+?)\s*(#.*)?$/)
        if (!match) continue
        const [, key, path] = match
        const trimmedPath = path.trim()
        if (!trimmedPath) continue
        const exists = fs.existsSync(trimmedPath)
        if (!exists) {
          checks.push({
            name: `standards.${key}`,
            status: 'warn',
            detail: `path not found: ${trimmedPath} — run /init scaffold-docs or create manually`,
          })
          continue
        }

        const stat = fs.statSync(trimmedPath)
        if (stat.isDirectory()) {
          // Check if the directory has at least one non-stub file (> 10 lines)
          let hasSubstantialFile = false
          try {
            const entries = fs.readdirSync(trimmedPath) as string[]
            for (const entry of entries) {
              const entryPath = `${trimmedPath}/${entry}`
              const entryStat = fs.statSync(entryPath)
              if (entryStat.isFile()) {
                const entryContent = fs.readFileSync(entryPath, 'utf8') as string
                if (entryContent.split('\n').length > 10) {
                  hasSubstantialFile = true
                  break
                }
              }
            }
          } catch {}
          checks.push({
            name: `standards.${key}`,
            status: hasSubstantialFile ? 'pass' : 'warn',
            detail: hasSubstantialFile
              ? trimmedPath
              : `${trimmedPath} — all files appear to be stubs — run /analyze or fill manually`,
          })
        } else {
          // File: check line count and TODO markers
          let fileStatus: 'pass' | 'warn' = 'pass'
          let fileDetail = trimmedPath
          try {
            const content = fs.readFileSync(trimmedPath, 'utf8') as string
            const lineCount = content.split('\n').length
            if (lineCount < 10) {
              fileStatus = 'warn'
              fileDetail = `${trimmedPath} — appears to be a stub (${lineCount} lines) — run /analyze or fill manually`
            } else if (content.includes('TODO:') && lineCount < 30) {
              fileStatus = 'warn'
              fileDetail = `${trimmedPath} — has TODO markers — fill with project-specific content or run /analyze`
            }
          } catch {}
          checks.push({
            name: `standards.${key}`,
            status: fileStatus,
            detail: fileDetail,
          })
        }
      }
    }

    if (checks.length === 0) {
      checks.push({ name: 'standards', status: 'skip', detail: 'no standards paths configured in stack.yml' })
    }
  } catch {
    checks.push({ name: 'standards', status: 'skip', detail: 'could not parse stack.yml' })
  }

  return { name: 'Standards', checks }
}

// --- Output formatting ---

const ICONS: Record<Status, string> = { pass: '✅', fail: '❌', warn: '⚠️', skip: '⏭' }

function formatText(sections: Section[]): string {
  const lines: string[] = ['dev-core doctor', '================', '']

  for (const section of sections) {
    lines.push(`  ${section.name}`)
    for (const check of section.checks) {
      lines.push(`    ${check.name.padEnd(20)} ${ICONS[check.status]} ${check.detail}`)
    }
    lines.push('')
  }

  // Verdict
  let total = 0
  let passed = 0
  for (const s of sections) {
    for (const c of s.checks) {
      if (c.status !== 'skip') {
        total++
        if (c.status === 'pass') passed++
      }
    }
  }

  const hasWarn = sections.some((s) => s.checks.some((c) => c.status === 'warn'))
  const hasFail = sections.some((s) => s.checks.some((c) => c.status === 'fail'))
  if (!hasFail && !hasWarn) {
    lines.push(`  Verdict: All ${total} checks passed. dev-core is fully configured.`)
  } else if (!hasFail) {
    lines.push(`  Verdict: ${passed}/${total} checks passed (${total - passed} warnings). dev-core is operational.`)
  } else {
    lines.push(`  Verdict: ${passed}/${total} checks passed. Run \`/init\` to fix missing items.`)
  }

  return lines.join('\n')
}

// --- Main ---

const jsonFlag = process.argv.includes('--json')

const prereqs = checkPrereqs()
const ghOk = prereqs.gh.ok
const owner = prereqs.gitRemote.owner
const repo = prereqs.gitRemote.repo
const fullRepo = owner && repo ? `${owner}/${repo}` : ''

const sections: Section[] = [
  checkPrereqsSection(prereqs),
  checkGitHubConfig(ghOk, owner, repo),
  checkLabels(ghOk, owner, repo),
  checkWorkflows(ghOk, owner, repo),
  checkSecrets(ghOk, owner, repo),
  checkProjectWorkflows(ghOk, owner),
  checkBranchProtection(ghOk, owner, fullRepo),
  checkRulesets(ghOk, owner, repo),
  checkProjectStructure(),
  checkStandardsPaths(),
  checkSecurity(),
  checkVercel(),
  checkCIPermissions(ghOk, owner, repo),
]

if (jsonFlag) {
  console.log(JSON.stringify(sections, null, 2))
} else {
  console.log(formatText(sections))
}

// Exit code: only hard failures trigger non-zero (warnings are informational)
const hasFail = sections.some((s) => s.checks.some((c) => c.status === 'fail'))
process.exit(hasFail ? 1 : 0)
