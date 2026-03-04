#!/usr/bin/env bun
/**
 * Doctor CLI — standalone health check for dev-core configuration.
 * Outputs formatted report (default) or JSON (--json).
 * Exit code: 0 = all pass, 1 = any failure.
 */

import { PROTECTED_BRANCHES, REQUIRED_SECRETS, STANDARD_LABELS, STANDARD_WORKFLOWS } from '../shared/config'
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

  const env = readEnvFile()
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
    checks.push({ name: 'GH_PROJECT_ID', status: 'fail', detail: 'not set in .env' })
  }

  // Field IDs
  for (const field of ['STATUS_FIELD_ID', 'SIZE_FIELD_ID', 'PRIORITY_FIELD_ID']) {
    const label = `${field.replace('_FIELD_ID', '').replace('_', ' ')} field`
    const val = env[field]
    checks.push({ name: label, status: val ? 'pass' : 'fail', detail: val ? 'configured' : 'not set in .env' })
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

  const env = readEnvFile()
  const projectId = env.GH_PROJECT_ID
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
  for (const branch of PROTECTED_BRANCHES) {
    // Check branch exists before checking protection
    const branchExists = spawnSync(['gh', 'api', `repos/${owner}/${repo}/branches/${branch}`])
    if (!branchExists.ok) {
      checks.push({ name: branch, status: 'skip', detail: 'branch does not exist' })
      continue
    }
    const result = spawnSync(['gh', 'api', `repos/${owner}/${repo}/branches/${branch}/protection`])
    checks.push({ name: branch, status: result.ok ? 'pass' : 'fail', detail: result.ok ? 'protected' : 'unprotected' })
  }
  return { name: 'Branch protection', checks }
}

function checkProjectStructure(): Section {
  const checks: Check[] = []

  // .env
  const envExists = require('node:fs').existsSync('.env')
  checks.push({ name: '.env', status: envExists ? 'pass' : 'fail', detail: envExists ? 'found' : 'missing' })

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

  // .gitleaks.toml
  const gitleaksExists = fs.existsSync('.gitleaks.toml')
  checks.push({
    name: '.gitleaks.toml',
    status: gitleaksExists ? 'pass' : 'warn',
    detail: gitleaksExists ? 'found' : 'missing — run /init to create (prevents secret leaks in CI)',
  })

  // .github/dependabot.yml
  const dependabotExists = fs.existsSync('.github/dependabot.yml')
  checks.push({
    name: 'dependabot.yml',
    status: dependabotExists ? 'pass' : 'warn',
    detail: dependabotExists ? 'found' : 'missing — run /init to create (automated dependency updates)',
  })

  // lock file — inferred from stack.yml package_manager
  let lockFile: string | null = null
  let pm = ''
  try {
    const stack = fs.readFileSync('.claude/stack.yml', 'utf8') as string
    const pmMatch = stack.match(/^\s*package_manager:\s*(\S+)/m)
    pm = pmMatch?.[1] ?? ''
    if (pm === 'uv') lockFile = 'uv.lock'
    else if (pm === 'bun') lockFile = 'bun.lock'
    else if (pm === 'npm') lockFile = 'package-lock.json'
    else if (pm === 'pnpm') lockFile = 'pnpm-lock.yaml'
    else if (pm === 'yarn') lockFile = 'yarn.lock'
    else if (pm === 'pip') lockFile = 'requirements.txt'
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
    const env = readEnvFile()
    const hasToken = !!process.env.VERCEL_TOKEN || !!env.VERCEL_TOKEN
    checks.push({ name: 'VERCEL_TOKEN', status: hasToken ? 'pass' : 'warn', detail: hasToken ? 'set' : 'not set' })
  }

  return { name: 'Vercel', checks }
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
  checkProjectStructure(),
  checkSecurity(),
  checkVercel(),
]

if (jsonFlag) {
  console.log(JSON.stringify(sections, null, 2))
} else {
  console.log(formatText(sections))
}

// Exit code: only hard failures trigger non-zero (warnings are informational)
const hasFail = sections.some((s) => s.checks.some((c) => c.status === 'fail'))
process.exit(hasFail ? 1 : 0)
