#!/usr/bin/env bun
/**
 * Doctor CLI — standalone health check for dev-core configuration.
 * Outputs formatted report (default) or JSON (--json).
 * Exit code: 0 = all pass, 1 = any failure.
 */

import { STANDARD_LABELS, STANDARD_WORKFLOWS, PROTECTED_BRANCHES } from '../shared/config'
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
    const text = require('fs').readFileSync('.env', 'utf8') as string
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
      { name: 'bun', status: prereqs.bun.ok ? 'pass' : 'fail', detail: prereqs.bun.ok ? prereqs.bun.version : 'not installed — https://bun.sh/' },
      { name: 'gh', status: prereqs.gh.ok ? 'pass' : 'fail', detail: prereqs.gh.ok ? prereqs.gh.detail : `${prereqs.gh.detail} — https://cli.github.com/` },
      { name: 'git remote', status: prereqs.gitRemote.ok ? 'pass' : 'fail', detail: prereqs.gitRemote.ok ? prereqs.gitRemote.url : 'no origin remote configured' },
    ],
  }
}

function checkGitHubConfig(ghOk: boolean, owner: string, repo: string): Section {
  const skip = (name: string) => ({ name, status: 'skip' as Status, detail: 'gh CLI not available' })
  if (!ghOk) return { name: 'GitHub', checks: ['GITHUB_REPO', 'GITHUB_TOKEN', 'PROJECT_ID', 'Status field', 'Size field', 'Priority field'].map(skip) }

  const env = readEnvFile()
  const checks: Check[] = []

  // GITHUB_REPO
  const ghRepo = env.GITHUB_REPO || (owner && repo ? `${owner}/${repo}` : '')
  checks.push({ name: 'GITHUB_REPO', status: ghRepo ? 'pass' : 'fail', detail: ghRepo || 'not set' })

  // GITHUB_TOKEN
  const hasToken = !!process.env.GITHUB_TOKEN || spawnSync(['gh', 'auth', 'token']).ok
  checks.push({ name: 'GITHUB_TOKEN', status: hasToken ? 'pass' : 'fail', detail: hasToken ? 'available' : 'not set and gh auth token failed' })

  // PROJECT_ID
  const projectId = env.PROJECT_ID
  if (projectId) {
    const projects = spawnSync(['gh', 'project', 'list', '--owner', owner, '--format', 'json', '--limit', '20'])
    let verified = false
    if (projects.ok) {
      try {
        const data = JSON.parse(projects.stdout) as { projects: { id: string }[] }
        verified = data.projects?.some((p) => p.id === projectId) ?? false
      } catch {}
    }
    checks.push({ name: 'PROJECT_ID', status: verified ? 'pass' : 'warn', detail: verified ? `${projectId} (verified)` : `${projectId} (not verified)` })
  } else {
    checks.push({ name: 'PROJECT_ID', status: 'fail', detail: 'not set in .env' })
  }

  // Field IDs
  for (const field of ['STATUS_FIELD_ID', 'SIZE_FIELD_ID', 'PRIORITY_FIELD_ID']) {
    const label = field.replace('_FIELD_ID', '').replace('_', ' ') + ' field'
    const val = env[field]
    checks.push({ name: label, status: val ? 'pass' : 'fail', detail: val ? 'configured' : 'not set in .env' })
  }

  return { name: 'GitHub', checks }
}

function checkLabels(ghOk: boolean, owner: string, repo: string): Section {
  if (!ghOk) return { name: 'Labels', checks: [{ name: 'labels', status: 'skip', detail: 'gh CLI not available' }] }

  const result = spawnSync(['gh', 'label', 'list', '--repo', `${owner}/${repo}`, '--json', 'name', '--limit', '100'])
  if (!result.ok) return { name: 'Labels', checks: [{ name: 'labels', status: 'fail', detail: 'could not fetch labels' }] }

  let existing: string[] = []
  try {
    existing = (JSON.parse(result.stdout) as { name: string }[]).map((l) => l.name)
  } catch {}

  const missing = STANDARD_LABELS.filter((l) => !existing.includes(l.name)).map((l) => l.name)
  const count = STANDARD_LABELS.length - missing.length

  if (missing.length === 0) {
    return { name: 'Labels', checks: [{ name: 'labels', status: 'pass', detail: `${STANDARD_LABELS.length}/${STANDARD_LABELS.length} present` }] }
  }
  return { name: 'Labels', checks: [{ name: 'labels', status: 'warn', detail: `${count}/${STANDARD_LABELS.length} present (missing: ${missing.join(', ')})` }] }
}

function checkWorkflows(): Section {
  const checks: Check[] = []
  for (const wf of STANDARD_WORKFLOWS) {
    const exists = require('fs').existsSync(`.github/workflows/${wf}`)
    checks.push({ name: wf, status: exists ? 'pass' : 'fail', detail: exists ? 'found' : 'missing' })
  }
  return { name: 'Workflows', checks }
}

function checkBranchProtection(ghOk: boolean, owner: string, repo: string): Section {
  if (!ghOk) return { name: 'Branch protection', checks: PROTECTED_BRANCHES.map((b) => ({ name: b, status: 'skip' as Status, detail: 'gh CLI not available' })) }

  const checks: Check[] = []
  for (const branch of PROTECTED_BRANCHES) {
    const result = spawnSync(['gh', 'api', `repos/${owner}/${repo}/branches/${branch}/protection`])
    checks.push({ name: branch, status: result.ok ? 'pass' : 'fail', detail: result.ok ? 'protected' : 'unprotected' })
  }
  return { name: 'Branch protection', checks }
}

function checkProjectStructure(): Section {
  const checks: Check[] = []

  // .env
  const envExists = require('fs').existsSync('.env')
  checks.push({ name: '.env', status: envExists ? 'pass' : 'fail', detail: envExists ? 'found' : 'missing' })

  // artifacts/
  const artifactDirs = ['frames', 'analyses', 'specs', 'plans']
  const allExist = artifactDirs.every((d) => require('fs').existsSync(`artifacts/${d}`))
  checks.push({ name: 'artifacts/', status: allExist ? 'pass' : 'fail', detail: allExist ? 'found' : 'missing subdirectories' })

  // dashboard script
  let hasDashboard = false
  try {
    const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'))
    hasDashboard = !!pkg.scripts?.dashboard
  } catch {}
  checks.push({ name: 'dashboard script', status: hasDashboard ? 'pass' : 'fail', detail: hasDashboard ? 'found' : 'missing in package.json' })

  return { name: 'Project', checks }
}

function checkVercel(): Section {
  const checks: Check[] = []

  const vercelExists = require('fs').existsSync('.vercel/project.json')
  checks.push({ name: '.vercel/project', status: vercelExists ? 'pass' : 'skip', detail: vercelExists ? 'found' : 'not found (optional)' })

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

  if (passed === total) {
    lines.push(`  Verdict: All ${total} checks passed. dev-core is fully configured.`)
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
  checkWorkflows(),
  checkBranchProtection(ghOk, owner, fullRepo),
  checkProjectStructure(),
  checkVercel(),
]

if (jsonFlag) {
  console.log(JSON.stringify(sections, null, 2))
} else {
  console.log(formatText(sections))
}

// Exit code
const hasFail = sections.some((s) => s.checks.some((c) => c.status === 'fail'))
process.exit(hasFail ? 1 : 0)
