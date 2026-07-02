/**
 * GitHub-related health checks for the doctor CLI.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import {
  DEFAULT_RULESET,
  MERGE_WORKFLOWS,
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

  const hasMergeWorkflow = MERGE_WORKFLOWS.some((m) => existsSync(`.github/workflows/${m}`) || remoteFiles.has(m))

  for (const wf of STANDARD_WORKFLOWS) {
    const localExists = existsSync(`.github/workflows/${wf}`)
    const remoteExists = remoteFiles.has(wf)
    const exists = localExists || remoteExists

    if (exists) {
      checks.push({ name: wf, status: 'pass', detail: localExists ? 'found locally' : 'found on remote' })
      continue
    }
    if ((MERGE_WORKFLOWS as readonly string[]).includes(wf)) {
      if (hasMergeWorkflow) {
        checks.push({ name: wf, status: 'skip', detail: 'skipped — alternate merge workflow present' })
        continue
      }
    }
    if (wf === 'deploy-preview.yml' && stack.deployPlatform !== 'vercel') {
      checks.push({ name: wf, status: 'skip', detail: 'skipped — deploy.platform is not vercel' })
      continue
    }
    if (wf === 'deploy-cloudflare.yml' && !stack.deployPlatform?.startsWith('cloudflare')) {
      checks.push({ name: wf, status: 'skip', detail: 'skipped — deploy.platform is not cloudflare' })
      continue
    }
    checks.push({ name: wf, status: 'warn', detail: 'missing — run /ci-setup to create' })
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
    const entry = REQUIRED_SECRETS[wf]
    const { mode, secret, var: varName } = entry
    const result = spawnSync(['gh', 'api', `/repos/${owner}/${repo}/actions/secrets/${secret}`])
    const fixCmd =
      mode === 'github-app'
        ? `gh secret set ${secret} --repo ${owner}/${repo} < key.pem${varName ? ` && gh variable set ${varName} --repo ${owner}/${repo} --body <app-id>` : ''}`
        : `gh secret set ${secret} --repo ${owner}/${repo} --body "$(gh auth token)"`
    checks.push({
      name: secret,
      status: result.ok ? 'pass' : 'warn',
      detail: result.ok ? `set (required by ${wf})` : `missing — required by ${wf}. Fix: ${fixCmd}`,
    })

    // github-app mode also requires the companion App-ID variable; a present
    // private-key secret with an absent variable still fails at workflow runtime.
    if (varName) {
      const varResult = spawnSync(['gh', 'api', `/repos/${owner}/${repo}/actions/variables/${varName}`])
      checks.push({
        name: varName,
        status: varResult.ok ? 'pass' : 'warn',
        detail: varResult.ok
          ? `set (required by ${wf})`
          : `missing — required by ${wf}. Fix: gh variable set ${varName} --repo ${owner}/${repo} --body <app-id>`,
      })
    }
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

    if (!detail) {
      checks.push({
        name: 'ruleset detail',
        status: 'warn',
        detail: 'could not fetch ruleset detail — cannot verify merge methods or branch targeting',
      })
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
      if (!defaultBranch) {
        checks.push({
          name: 'Default branch targeted',
          status: 'skip',
          detail: meta ? 'default branch unknown' : 'repo meta unavailable — cannot verify ruleset coverage',
        })
      }
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
  } else if (ruleset) {
    checks.push({
      name: 'ruleset detail',
      status: 'warn',
      detail: 'ruleset id missing or not numeric — cannot verify merge methods or branch targeting',
    })
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

// ---------------------------------------------------------------------------
// Dead Gate detector
// ---------------------------------------------------------------------------

/**
 * Unsafe token patterns in CI workflows — triggers a DEAD GATE finding.
 *
 * Anti-recursion rule: pushes made via `github.token` / `secrets.GITHUB_TOKEN`
 * are silently dropped by GitHub Actions; the push workflow never re-triggers.
 * This is a dead gate — CI appears wired but never actually runs on automation
 * pushes.
 *
 * Safe patterns (must NOT false-positive):
 *   - `secrets.PAT`  — legacy PAT, causes a warn not a fail
 *   - `steps.<id>.outputs.token`  — App token via actions/create-github-app-token
 */
export function detectUnsafeTokenInTriggeredWorkflow(
  content: string,
  filePath: string,
): Array<{ file: string; job: string; step: string; kind: 'dead' | 'pat-warn'; token: string }> {
  const lines = content.split('\n')
  const issues: Array<{ file: string; job: string; step: string; kind: 'dead' | 'pat-warn'; token: string }> = []

  // --- 1. Determine if this workflow is push-triggered ---
  // We look at the `on:` section at root level.
  let isPushTriggered = false
  let isBotTriggered = false // workflow_run, workflow_dispatch used by bots
  let inOnBlock = false
  let onIndent = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Detect `on:` root key
    if (/^on:\s*$/.test(line)) {
      inOnBlock = true
      onIndent = 0
      continue
    }
    // Compact form: `on: [push, pull_request]` or `on: push`
    if (/^on:\s+\S/.test(line)) {
      const val = line.replace(/^on:\s+/, '').trim()
      if (val.includes('push')) isPushTriggered = true
      if (val.includes('workflow_run') || val.includes('workflow_dispatch')) isBotTriggered = true
      break
    }

    if (inOnBlock) {
      // End of on block when we hit another root-level key
      if (/^\S/.test(line) && line.trim() && !line.trim().startsWith('#')) {
        inOnBlock = false
        break
      }
      const m = line.match(/^ {2}([a-zA-Z0-9_-]+):\s*/)
      if (m) {
        if (m[1] === 'push') isPushTriggered = true
        if (m[1] === 'workflow_run' || m[1] === 'workflow_dispatch') isBotTriggered = true
      }
    }
  }

  // Only scan push-triggered workflows (or bot-triggered that use push semantics)
  if (!isPushTriggered && !isBotTriggered) return issues

  // --- 2. Detect steps using unsafe tokens ---
  // We scan for env vars or `with:` fields containing the dangerous expressions.
  // Safe: steps.<id>.outputs.token (App token)
  // Dead: github.token, secrets.GITHUB_TOKEN
  // Warn: secrets.PAT

  const DEAD_PATTERNS = [/\$\{\{\s*github\.token\s*\}\}/, /\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/]
  const PAT_PATTERN = /\$\{\{\s*secrets\.PAT\s*\}\}/

  // Walk jobs section
  let jobsSectionLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^jobs:\s*$/.test(lines[i])) {
      jobsSectionLine = i
      break
    }
  }
  if (jobsSectionLine === -1) return issues

  // Find job headers (2-space indent)
  const jobHeaders: Array<{ name: string; start: number }> = []
  for (let i = jobsSectionLine + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}([a-zA-Z0-9][a-zA-Z0-9_-]*):\s*$/)
    if (m) {
      jobHeaders.push({ name: m[1], start: i })
    } else if (/^\S/.test(lines[i]) && lines[i].trim() && !lines[i].trimStart().startsWith('#')) {
      break
    }
  }

  for (let j = 0; j < jobHeaders.length; j++) {
    const { name: jobName, start } = jobHeaders[j]
    const end = j + 1 < jobHeaders.length ? jobHeaders[j + 1].start : lines.length
    const jobLines = lines.slice(start + 1, end)

    // Find step names and step bodies
    const stepHeaders: Array<{ name: string; start: number }> = []
    for (let i = 0; i < jobLines.length; i++) {
      const m = jobLines[i].match(/^ {6}- name:\s+(.+)$/)
      if (m) {
        stepHeaders.push({ name: m[1].trim(), start: i })
      } else if (/^ {6}- uses:/.test(jobLines[i]) || /^ {6}- run:/.test(jobLines[i])) {
        // Unnamed step
        stepHeaders.push({ name: `(unnamed step ${stepHeaders.length + 1})`, start: i })
      }
    }

    // Scan job-level config (the preamble before the first step) — e.g. a job-level
    // `env:` token applies to every step, so a dead token there is a dead gate too.
    const firstStepStart = stepHeaders.length > 0 ? stepHeaders[0].start : jobLines.length
    const preamble = jobLines
      .slice(0, firstStepStart)
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n')
    for (const pat of DEAD_PATTERNS) {
      if (pat.test(preamble)) {
        const tokenMatch = preamble.match(pat)
        issues.push({
          file: filePath,
          job: jobName,
          step: '(job-level env)',
          kind: 'dead',
          token: tokenMatch ? tokenMatch[0] : 'github.token/GITHUB_TOKEN',
        })
        break
      }
    }
    if (PAT_PATTERN.test(preamble)) {
      issues.push({ file: filePath, job: jobName, step: '(job-level env)', kind: 'pat-warn', token: 'secrets.PAT' })
    }

    // Scan each step body for token usage
    for (let s = 0; s < stepHeaders.length; s++) {
      const stepStart = stepHeaders[s].start
      const stepEnd = s + 1 < stepHeaders.length ? stepHeaders[s + 1].start : jobLines.length
      const stepLines = jobLines.slice(stepStart, stepEnd)
      // Strip comment lines before pattern matching to avoid false positives on commented-out tokens
      const activeLines = stepLines.filter((l) => !l.trimStart().startsWith('#'))
      const stepBody = activeLines.join('\n')

      // A step using only the safe App token (steps.<id>.outputs.token) matches none
      // of the DEAD/PAT patterns below, so it is not flagged. We do NOT early-continue
      // on a safe token: a step that ALSO references a dead token must still be flagged.
      for (const pat of DEAD_PATTERNS) {
        if (pat.test(stepBody)) {
          const tokenMatch = stepBody.match(pat)
          issues.push({
            file: filePath,
            job: jobName,
            step: stepHeaders[s].name,
            kind: 'dead',
            token: tokenMatch ? tokenMatch[0] : 'github.token/GITHUB_TOKEN',
          })
          break // one finding per step
        }
      }

      if (PAT_PATTERN.test(stepBody)) {
        issues.push({
          file: filePath,
          job: jobName,
          step: stepHeaders[s].name,
          kind: 'pat-warn',
          token: 'secrets.PAT',
        })
      }
    }
  }

  return issues
}

/**
 * Push-gate merge-relative history check.
 *
 * For each workflow targeting push on staging/main: fetch the last N+slack
 * runs and compare how many were push-event vs how many merge commits landed.
 * If 0 push runs while ≥N merges landed → DEAD GATE.
 *
 * Grace window: skip workflows/repos younger than GRACE_DAYS.
 */
const PUSH_GATE_MERGE_THRESHOLD = 5
const GRACE_DAYS = 14
export const DORMANCY_MIN_RUNS = 5
export const DORMANCY_RUN_LIMIT = 10

// Returns the age in days of the ISO timestamp in `result.stdout`, or Infinity when
// it cannot be determined (fail-open: an unknown age never triggers a false dead-gate).
function ageInDays(result: { ok: boolean; stdout: string }): number {
  if (!result.ok || !result.stdout.trim()) return Number.POSITIVE_INFINITY
  const created = new Date(result.stdout.trim())
  if (Number.isNaN(created.getTime())) return Number.POSITIVE_INFINITY
  return (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24)
}

export function repoAgeOk(owner: string, repo: string): boolean {
  return (
    ageInDays(spawnSync(['gh', 'repo', 'view', `${owner}/${repo}`, '--json', 'createdAt', '--jq', '.createdAt'])) >=
    GRACE_DAYS
  )
}

/**
 * Grace window for a single workflow: a workflow file added recently to an OLD repo
 * legitimately has 0 push runs yet — that is not a dead gate. Exported so #288
 * (per-job dormancy) can reuse the same grace logic without duplicating it.
 */
export function workflowAgeOk(owner: string, repo: string, workflow: string): boolean {
  return (
    ageInDays(
      spawnSync(['gh', 'api', `repos/${owner}/${repo}/actions/workflows/${workflow}`, '--jq', '.created_at']),
    ) >= GRACE_DAYS
  )
}

function countPushRuns(owner: string, repo: string, workflow: string, branch: string): number {
  const result = spawnSync([
    'gh',
    'run',
    'list',
    '--repo',
    `${owner}/${repo}`,
    '--workflow',
    workflow,
    '--branch',
    branch,
    '--event',
    'push',
    '--limit',
    '20',
    '--json',
    'databaseId',
    '--jq',
    'length',
  ])
  if (!result.ok) return -1
  const n = parseInt(result.stdout.trim(), 10)
  return Number.isNaN(n) ? -1 : n
}

function countMergeCommits(owner: string, repo: string, branch: string, n: number): number {
  const result = spawnSync([
    'gh',
    'api',
    `repos/${owner}/${repo}/commits`,
    '--jq',
    `[.[] | select(.commit.message | startswith("Merge"))] | length`,
    '-X',
    'GET',
    '-f',
    `sha=${branch}`,
    '-f',
    // Widen the lookback (≥100, the API page max) so sparse-merge repos — many direct
    // commits between merges — can still reach the N-merge anchor (avoids false negatives).
    `per_page=${Math.max(100, n * 4)}`,
  ])
  if (!result.ok) return -1
  const count = parseInt(result.stdout.trim(), 10)
  return Number.isNaN(count) ? -1 : count
}

// ── T1: Workflow job parser ────────────────────────────────────────────────────

export interface ParsedJob {
  id: string
  displayName: string
  hasIf: boolean
  matrixEmpty: boolean
  needs: string[]
}

/**
 * Pure parser: extract job metadata from a workflow YAML string.
 * Uses the same 2-space header idiom as detectUnsafeTokenInTriggeredWorkflow.
 * No I/O — safe to unit-test without a filesystem.
 */
export function parseWorkflowJobs(content: string): ParsedJob[] {
  const lines = content.split('\n')

  // Find `jobs:` section
  let jobsSectionLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^jobs:\s*$/.test(lines[i])) {
      jobsSectionLine = i
      break
    }
  }
  if (jobsSectionLine === -1) return []

  // Collect 2-space-indented job headers under `jobs:`
  const jobHeaders: Array<{ name: string; start: number }> = []
  for (let i = jobsSectionLine + 1; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}([a-zA-Z0-9][a-zA-Z0-9_-]*):\s*$/)
    if (m) {
      jobHeaders.push({ name: m[1], start: i })
    } else if (/^\S/.test(lines[i]) && lines[i].trim() && !lines[i].trimStart().startsWith('#')) {
      break
    }
  }

  const jobs: ParsedJob[] = []
  for (let j = 0; j < jobHeaders.length; j++) {
    const { name: id, start } = jobHeaders[j]
    const end = j + 1 < jobHeaders.length ? jobHeaders[j + 1].start : lines.length
    const jobLines = lines.slice(start + 1, end)

    // Extract display name (4-space-indented `name:` field)
    let displayName = id
    for (const line of jobLines) {
      const nm = line.match(/^ {4}name:\s+(.+)$/)
      if (nm) {
        displayName = nm[1].trim().replace(/^['"]|['"]$/g, '')
        break
      }
    }

    // Detect job-level `if:` (4-space-indented)
    const hasIf = jobLines.some((l) => /^ {4}if:\s*\S/.test(l))

    // Detect statically-empty matrix:
    //   strategy.matrix: {}  or  strategy.matrix: []  or any axis: []
    let matrixEmpty = false
    let inMatrix = false
    for (const line of jobLines) {
      if (/^ {6}matrix:\s*$/.test(line) || /^ {6}matrix:\s*(\{\}|\[\])\s*$/.test(line)) {
        inMatrix = true
        if (/^ {6}matrix:\s*(\{\}|\[\])\s*$/.test(line)) matrixEmpty = true
        continue
      }
      if (inMatrix) {
        // An axis with an empty list: `      axis: []`
        if (/^ {8}[a-zA-Z0-9_-]+:\s*\[\]\s*$/.test(line)) {
          matrixEmpty = true
        }
        // Left the matrix block
        if (/^ {0,5}\S/.test(line)) inMatrix = false
      }
    }

    // Extract needs: (scalar string, inline array, or YAML list)
    const needs: string[] = []
    let inNeeds = false
    for (const line of jobLines) {
      if (/^ {4}needs:\s*\S/.test(line)) {
        const val = line.replace(/^ {4}needs:\s*/, '').trim()
        if (val.startsWith('[') && val.endsWith(']')) {
          // Inline array: `    needs: [build, lint]`
          const inner = val.slice(1, -1)
          for (const item of inner.split(',')) {
            const trimmed = item.trim().replace(/^['"]|['"]$/g, '')
            if (trimmed) needs.push(trimmed)
          }
        } else {
          // Scalar: `    needs: build`
          needs.push(val.replace(/^['"]|['"]$/g, ''))
        }
        inNeeds = false
        continue
      }
      if (/^ {4}needs:\s*$/.test(line)) {
        inNeeds = true
        continue
      }
      if (inNeeds) {
        const item = line.match(/^ {6}-\s+(.+)$/)
        if (item) {
          needs.push(item[1].trim().replace(/^['"]|['"]$/g, ''))
        } else {
          inNeeds = false
        }
      }
    }

    jobs.push({ id, displayName, hasIf, matrixEmpty, needs })
  }

  return jobs
}

// ── T2: Dormancy verdict ───────────────────────────────────────────────────────

export type DormancyVerdict = 'alive' | 'dormant_required' | 'dormant_wiring' | 'conditional_ok'

/**
 * Pure verdict function — no I/O.
 * Precedence: insufficient history → alive; executed > 0 → alive;
 * required check → fail (dormant_required); empty matrix or no if → warn (dormant_wiring);
 * has if + not required → conditional_ok (not flagged).
 */
export function classifyDormancy(
  job: ParsedJob,
  stats: JobRunStats,
  isRequired: boolean,
  minRuns: number,
): DormancyVerdict {
  if (stats.considered < minRuns) return 'alive'
  if (stats.executed > 0) return 'alive'
  // executed == 0 and sufficient history
  if (isRequired) return 'dormant_required'
  if (job.matrixEmpty || !job.hasIf) return 'dormant_wiring'
  return 'conditional_ok'
}

// ── T3: Run-history aggregation ────────────────────────────────────────────────

export interface JobRunStats {
  considered: number
  executed: number
  skipped: number
}

export interface RunRecord {
  runConclusion: string
  // `conclusion` is null for an in-progress/queued job leg — `gh run view --json jobs` returns
  // null, not '' — so the type must admit null (#288 review #2). Boolean(j.conclusion) below treats
  // both null and '' as "not executed", so widening the type changes no behavior, only honesty.
  jobs: Array<{ name: string; conclusion: string | null }>
}

/**
 * Pure aggregation: given a list of run records and a parsed job, return JobRunStats.
 * Run-level eligibility: exclude runs with runConclusion ∈ {skipped, cancelled}.
 * Absent-job exclusion: considered counts only retained runs where the job entry appears.
 * Matrix-leg matching: anchored prefix — historyName === displayName OR startsWith(displayName + ' (').
 *   `siblings` (other jobs' display names) are excluded from prefix matches so a parent job never
 *   absorbs a separate job that literally shares its prefix ("Build" vs "Build (debug)") (#288 review #3).
 * Only a real, non-skipped conclusion counts as executed; a null/empty (in-progress) conclusion does
 * not, else an in-flight run would fail-open and mask a dormant required gate (#288 review #2).
 *
 * @param siblings other jobs' display names, excluded from prefix matches (see above). The empty
 *   default reproduces the pre-guard (greedy) attribution and is a silent-regression hazard: a
 *   production caller that omits it loses the "Build" vs "Build (debug)" separation with no type
 *   error. The dormancy path (fetchJobHistory) MUST pass the real sibling set; the default exists
 *   only for direct unit tests of the bare matrix-leg semantics.
 */
export function aggregateJobStats(job: ParsedJob, runs: RunRecord[], siblings: Set<string> = new Set()): JobRunStats {
  let considered = 0
  let executed = 0
  let skipped = 0

  for (const run of runs) {
    const c = run.runConclusion
    if (c === 'skipped' || c === 'cancelled') continue

    // Find all job entries for this job (direct match or matrix leg). A sibling job whose literal
    // name shares the prefix ("Build (debug)" vs matrix parent "Build") is excluded so its runs are
    // never absorbed into the parent's stats (#288 review #3).
    const matching = run.jobs.filter(
      (j) => j.name === job.displayName || (j.name.startsWith(job.displayName + ' (') && !siblings.has(j.name)),
    )
    if (matching.length === 0) continue // job absent from this run — don't count

    considered++
    // At least one leg actually ran (a real, non-skipped conclusion) → executed. A null/empty
    // conclusion (in-progress/queued) must NOT count as executed, else an in-flight run fails open
    // and masks a dormant required gate (#288 review #2).
    const anyExecuted = matching.some((j) => Boolean(j.conclusion) && j.conclusion !== 'skipped')
    if (anyExecuted) {
      executed++
    } else {
      skipped++
    }
  }

  return { considered, executed, skipped }
}

// ── T4: Required-context lookup + job history fetch ───────────────────────────

/**
 * Pure parser: extract required check contexts from a branch-protection API response.
 * Handles both response shapes so each source can be parsed by the same function:
 *   - classic protection (object): dual-root `contexts[]` + `checks[].context`,
 *     and the `required_status_checks` nested form.
 *   - ruleset rules (top-level array): each `required_status_checks` rule's
 *     `parameters.required_status_checks[].context`.
 * Any parse failure / empty string → ∅ (fail-open: a missing protection response never escalates).
 */
export function parseRequiredContexts(apiJson: string): Set<string> {
  const out = new Set<string>()
  try {
    const data = JSON.parse(apiJson)
    if (!data || typeof data !== 'object') return out

    // Ruleset endpoint: a top-level array of rules — collect required_status_checks contexts.
    if (Array.isArray(data)) {
      for (const rule of data) {
        if (rule?.type === 'required_status_checks' && Array.isArray(rule?.parameters?.required_status_checks)) {
          for (const rsc of rule.parameters.required_status_checks) {
            if (rsc && typeof rsc.context === 'string') out.add(rsc.context)
          }
        }
      }
      return out
    }

    // Classic endpoint: `required_status_checks.contexts[]` or top-level `contexts[]`
    const rsc = data.required_status_checks ?? data
    if (Array.isArray(rsc.contexts)) {
      for (const ctx of rsc.contexts) {
        if (typeof ctx === 'string') out.add(ctx)
      }
    }
    // Classic endpoint (modern Checks-API): `.checks[].context` at rsc level or top-level
    if (Array.isArray(rsc.checks)) {
      for (const ch of rsc.checks) {
        if (ch && typeof ch.context === 'string') out.add(ch.context)
      }
    }
  } catch {
    // parse failure → contribute nothing (fail-open)
  }
  return out
}

/**
 * Fetch required status check contexts for a branch, unioning three sources:
 * 1. Classic branch protection `contexts[]`
 * 2. Classic branch protection `checks[].context`
 * 3. Ruleset `required_status_checks` rule contexts
 * Any 404 / error → contributes ∅ (fail-open: never escalates).
 */
export function fetchRequiredContexts(owner: string, repo: string, branch: string): Set<string> {
  const out = new Set<string>()

  // Source 1+2: classic branch protection. NOTE: `gh api` does NOT accept --repo (the owner/repo
  // is embedded in the path); passing it errors with "unknown flag: --repo" → result.ok=false →
  // fail-open. --repo belongs only on `gh run list`/`gh run view` (see fetchJobHistory).
  const classicResult = spawnSync([
    'gh',
    'api',
    `repos/${owner}/${repo}/branches/${branch}/protection/required_status_checks`,
  ])
  if (classicResult.ok) {
    for (const ctx of parseRequiredContexts(classicResult.stdout)) out.add(ctx)
  }

  // Source 3: ruleset `required_status_checks` rule contexts (parsed by the same fn)
  const rulesetResult = spawnSync(['gh', 'api', `repos/${owner}/${repo}/rules/branches/${branch}`])
  if (rulesetResult.ok) {
    for (const ctx of parseRequiredContexts(rulesetResult.stdout)) out.add(ctx)
  }

  return out
}

/**
 * Fetch the last DORMANCY_RUN_LIMIT push runs for a workflow/branch and build a
 * Map<jobDisplayName, JobRunStats> for each parsed job.
 * Passes --repo owner/repo on every gh call (cron-safe from arbitrary cwd).
 */
export function fetchJobHistory(
  owner: string,
  repo: string,
  wf: string,
  branch: string,
  jobs: ParsedJob[],
  limit: number,
): Map<string, JobRunStats> {
  // List run IDs
  const listResult = spawnSync([
    'gh',
    'run',
    'list',
    '--repo',
    `${owner}/${repo}`,
    '--workflow',
    wf,
    '--branch',
    branch,
    '--event',
    'push',
    '--limit',
    String(limit),
    '--json',
    'databaseId,conclusion',
  ])
  if (!listResult.ok) return new Map()

  let runList: Array<{ databaseId: number; conclusion: string }> = []
  try {
    runList = JSON.parse(listResult.stdout)
  } catch {
    return new Map()
  }

  // Fetch each run's job details
  const runRecords: RunRecord[] = []
  for (const run of runList) {
    const viewResult = spawnSync([
      'gh',
      'run',
      'view',
      String(run.databaseId),
      '--repo',
      `${owner}/${repo}`,
      '--json',
      'jobs,conclusion',
    ])
    if (!viewResult.ok) continue
    try {
      const data = JSON.parse(viewResult.stdout)
      runRecords.push({
        runConclusion: data.conclusion ?? run.conclusion ?? '',
        jobs: Array.isArray(data.jobs)
          ? data.jobs.map((j: { name: string; conclusion: string | null }) => ({
              name: j.name,
              conclusion: j.conclusion,
            }))
          : [],
      })
    } catch {}
  }

  // Aggregate stats per job. Pass each job the set of OTHER jobs' display names so a matrix parent
  // ("Build") never absorbs a separate job that literally shares its prefix ("Build (debug)").
  const allNames = new Set(jobs.map((j) => j.displayName))
  const statsMap = new Map<string, JobRunStats>()
  for (const job of jobs) {
    const siblings = new Set([...allNames].filter((n) => n !== job.displayName))
    statsMap.set(job.id, aggregateJobStats(job, runRecords, siblings))
  }
  return statsMap
}

/**
 * A workflow job is a required status check if its display name matches a required context
 * directly, OR if any matrix-leg context registered under it ("Build (ubuntu-latest)") matches.
 * Matrix jobs register one context per leg and never the bare parent name, so the anchored-prefix
 * check is mandatory for the AC-7 (dormant_required) escalation to fire on matrix jobs (#288 review #1).
 *
 * @param siblings other jobs' display names. A required context that exactly matches a sibling's
 *   display name ("Build (debug)") belongs to that separate static job, NOT to a matrix leg of this
 *   one — so it is excluded from the prefix match. This is the mirror of the aggregateJobStats
 *   sibling guard (#288 review #1, iter-2): without it, a required static "Build (debug)" would make
 *   a dormant matrix "Build" wrongly read as required and escalate to fail. The empty default
 *   reproduces the pre-guard (greedy) behavior — callers in the dormancy path MUST pass the real
 *   sibling set; the default exists only for direct unit tests of the bare-prefix semantics.
 */
export function isJobRequired(
  displayName: string,
  requiredContexts: Set<string>,
  siblings: Set<string> = new Set(),
): boolean {
  return (
    requiredContexts.has(displayName) ||
    [...requiredContexts].some((c) => c.startsWith(displayName + ' (') && !siblings.has(c))
  )
}

// ── T5: detectDormantJobs orchestrator ────────────────────────────────────────

/**
 * For each protected branch × each standard workflow that has push runs and passes
 * workflowAgeOk, parse jobs, cross-ref history, classify dormancy, emit Check[] for
 * dormant_required (fail) and dormant_wiring (warn) only.
 */
export function detectDormantJobs(ghOk: boolean, owner: string, repo: string): Check[] {
  if (!ghOk || !repoAgeOk(owner, repo)) return []

  const checks: Check[] = []
  // Memoize required contexts per branch
  const reqCache = new Map<string, Set<string>>()

  for (const branch of PROTECTED_BRANCHES) {
    // Check branch exists
    const branchCheck = spawnSync(['gh', 'api', `repos/${owner}/${repo}/branches/${branch}`])
    if (!branchCheck.ok) continue

    for (const wf of STANDARD_WORKFLOWS) {
      // Only check workflows that are alive at the workflow level (have push runs)
      const pushCount = countPushRuns(owner, repo, wf, branch)
      if (pushCount <= 0) continue

      // Grace window on the workflow itself
      if (!workflowAgeOk(owner, repo, wf)) continue

      // Read local workflow file
      const wfPath = `.github/workflows/${wf}`
      if (!existsSync(wfPath)) continue
      let content: string
      try {
        content = readFileSync(wfPath, 'utf8') as string
      } catch {
        continue
      }

      const jobs = parseWorkflowJobs(content)
      if (jobs.length === 0) continue

      // Fetch required contexts (memoized per branch)
      if (!reqCache.has(branch)) {
        reqCache.set(branch, fetchRequiredContexts(owner, repo, branch))
      }
      const requiredContexts = reqCache.get(branch)!

      // Fetch job history
      const statsMap = fetchJobHistory(owner, repo, wf, branch, jobs, DORMANCY_RUN_LIMIT)

      // Other jobs' display names — passed to isJobRequired so a matrix parent ("Build") never
      // claims a required context that belongs to a separate static sibling ("Build (debug)").
      const allJobNames = new Set(jobs.map((j) => j.displayName))

      for (const job of jobs) {
        const stats = statsMap.get(job.id) ?? { considered: 0, executed: 0, skipped: 0 }
        const siblings = new Set([...allJobNames].filter((n) => n !== job.displayName))
        const isRequired = isJobRequired(job.displayName, requiredContexts, siblings)
        const verdict = classifyDormancy(job, stats, isRequired, DORMANCY_MIN_RUNS)

        if (verdict === 'dormant_required') {
          checks.push({
            name: `${wf}:${branch}:${job.displayName} dormancy`,
            status: 'fail',
            detail: `required status check '${job.displayName}' never ran in last ${stats.considered} eligible runs — merge gate proves nothing (#579).`,
          })
        } else if (verdict === 'dormant_wiring') {
          const reason = job.matrixEmpty
            ? 'matrix expands to 0 legs — job can never run'
            : `job skipped in all ${stats.considered} eligible runs — dead wiring (broken needs/empty matrix)`
          checks.push({
            name: `${wf}:${branch}:${job.displayName} dormancy`,
            status: 'warn',
            detail: reason,
          })
        }
        // alive + conditional_ok → emit nothing
      }
    }
  }

  return checks
}

export function checkDeadGates(ghOk: boolean, owner: string, repo: string): Section {
  const sectionName = 'Dead Gates'
  const skip = (detail: string): Section => ({
    name: sectionName,
    checks: [{ name: 'token taxonomy + push-gate', status: 'skip' as Status, detail }],
  })

  if (!owner || !repo) return skip('repo not detected')

  const checks: Check[] = []

  // --- A. Token taxonomy (static YAML scan) ---
  const wfDir = '.github/workflows'
  const wfFiles: string[] = []
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir) as string[]) {
      if (f.endsWith('.yml') || f.endsWith('.yaml')) {
        wfFiles.push(`${wfDir}/${f}`)
      }
    }
  }

  if (wfFiles.length === 0) {
    checks.push({ name: 'token taxonomy', status: 'skip', detail: 'no local workflow files found' })
  } else {
    const tokenIssues: Array<{ file: string; job: string; step: string; kind: 'dead' | 'pat-warn'; token: string }> = []
    for (const filePath of wfFiles) {
      let content: string
      try {
        content = readFileSync(filePath, 'utf8') as string
      } catch {
        checks.push({ name: filePath, status: 'warn', detail: 'could not read file — skipped' })
        continue
      }
      tokenIssues.push(...detectUnsafeTokenInTriggeredWorkflow(content, filePath))
    }

    if (tokenIssues.length === 0) {
      checks.push({
        name: 'token taxonomy',
        status: 'pass',
        detail: `${wfFiles.length} workflow(s) checked — no unsafe token usage in push-triggered steps`,
      })
    } else {
      for (const issue of tokenIssues) {
        const fileName = issue.file.replace('.github/workflows/', '')
        if (issue.kind === 'dead') {
          checks.push({
            name: `${fileName}:${issue.job}:${issue.step}`,
            status: 'fail',
            detail: `push/bot-triggered step uses ${issue.token} — DEAD GATE (GitHub drops pushes from GITHUB_TOKEN; workflow never re-triggers). Use App token or secrets.PAT.`,
          })
        } else {
          checks.push({
            name: `${fileName}:${issue.job}:${issue.step}`,
            status: 'warn',
            detail: `step uses secrets.PAT — legacy token (retiring org-wide). Migrate to App token (actions/create-github-app-token).`,
          })
        }
      }
    }
  }

  // --- B. Push-gate merge-relative history ---
  if (!ghOk) {
    checks.push({ name: 'push-gate history', status: 'skip', detail: 'gh CLI not available' })
    return { name: sectionName, checks }
  }
  if (!repoAgeOk(owner, repo)) {
    checks.push({
      name: 'push-gate history',
      status: 'skip',
      detail: `repo younger than ${GRACE_DAYS} days — insufficient history`,
    })
    return { name: sectionName, checks }
  }

  // Only check protected branches (staging/main)
  for (const branch of PROTECTED_BRANCHES) {
    // Check if branch exists
    const branchCheck = spawnSync(['gh', 'api', `repos/${owner}/${repo}/branches/${branch}`])
    if (!branchCheck.ok) continue

    // Check each standard workflow for push-gate health
    for (const wf of STANDARD_WORKFLOWS) {
      const pushCount = countPushRuns(owner, repo, wf, branch)
      if (pushCount === -1) continue // workflow may not exist — skip
      if (pushCount > 0) continue // at least some push runs landed — gate is alive

      const mergeCount = countMergeCommits(owner, repo, branch, PUSH_GATE_MERGE_THRESHOLD)
      if (mergeCount === -1 || mergeCount < PUSH_GATE_MERGE_THRESHOLD) continue

      // Grace window on the WORKFLOW itself: a recently-added workflow (even on an old
      // repo) has 0 push runs because it is new, not dead — don't false-flag it.
      if (!workflowAgeOk(owner, repo, wf)) continue

      checks.push({
        name: `${wf}:${branch}:push-gate`,
        status: 'fail',
        detail: `0 push-event runs on ${branch} while ≥${PUSH_GATE_MERGE_THRESHOLD} merge commits landed — workflow is a DEAD GATE (never actually runs on pushes to ${branch}).`,
      })
    }
  }

  // --- C. Per-job dormancy detector ---
  const dormantChecks = detectDormantJobs(ghOk, owner, repo)
  for (const c of dormantChecks) checks.push(c)

  if (checks.length === 0) {
    checks.push({
      name: 'push-gate history',
      status: 'pass',
      detail: 'no dead push-gates or dormant jobs detected',
    })
  }

  return { name: sectionName, checks }
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

  if (!meta) {
    checks.push({
      name: 'repo visibility',
      status: 'warn',
      detail: 'could not fetch repo metadata — severity may be understated on private repos',
    })
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
