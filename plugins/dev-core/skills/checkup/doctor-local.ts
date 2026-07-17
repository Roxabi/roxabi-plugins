/**
 * Local project structure and security checks for the doctor CLI.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import { parseStackYml } from '../../hooks/lib/parse-stack-yml.cjs'
import type { PrereqResult } from '../shared/prereqs'
import { type Check, readConfig, type Section, spawnSync } from './doctor-shared'

function readParsedStack(): ReturnType<typeof parseStackYml> {
  const raw = fs.readFileSync('.claude/stack.yml', 'utf8') as string
  return parseStackYml(raw)
}

export function checkPrereqsSection(prereqs: PrereqResult): Section {
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

export function checkProjectStructure(): Section {
  const checks: Check[] = []

  // .claude/dev-core.yml (primary config)
  const devCoreYmlExists = fs.existsSync('.claude/dev-core.yml')
  checks.push({
    name: 'dev-core.yml',
    status: devCoreYmlExists ? 'pass' : 'warn',
    detail: devCoreYmlExists
      ? 'found (.claude/dev-core.yml)'
      : 'missing — config read from .env fallback. Run /init to generate.',
  })

  // .env (legacy fallback)
  const envExists = fs.existsSync('.env')
  checks.push({
    name: '.env',
    status: envExists ? 'pass' : devCoreYmlExists ? 'skip' : 'fail',
    detail: envExists ? 'found' : devCoreYmlExists ? 'not needed (dev-core.yml present)' : 'missing',
  })

  // artifacts/
  const artifactDirs = ['frames', 'analyses', 'specs', 'plans']
  const allExist = artifactDirs.every((d) => fs.existsSync(`artifacts/${d}`))
  checks.push({
    name: 'artifacts/',
    status: allExist ? 'pass' : 'fail',
    detail: allExist ? 'found' : 'missing subdirectories',
  })

  // roxabi shim + PATH
  const home = os.homedir()
  const shimPaths = [`${home}/.local/bin/roxabi`, `${home}/bin/roxabi`]
  const inPath = spawnSync(['sh', '-c', 'command -v roxabi']).ok
  const shimFile = shimPaths.find((p) => fs.existsSync(p))
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

export interface DependabotCooldownFinding {
  ecosystem: string
  property: string
}

/**
 * Ecosystems whose cooldown accepts `default-days` only — `semver-*-days` there is
 * rejected by GitHub at parse time. The complement (npm, gomod, cargo, pip, uv, bun,
 * bundler, composer, maven, gradle, nuget, hex, pub, swift, deno, dotnet, elm, conda,
 * julia, sbt, rust) DOES support semver — flagging any of those would be a false positive.
 *
 * Source (verified against the live table, fetched 2026-07-17):
 * https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference
 * Re-verify here if GitHub adds semver support to an ecosystem below.
 *
 * Safe-by-construction: a wrong/misspelled value degrades to a miss (never matches an
 * actual block), so it can only under-report — never a false positive.
 */
const SEMVER_COOLDOWN_UNSUPPORTED = new Set([
  'bazel',
  'devcontainers',
  'docker',
  'docker-compose',
  'github-actions',
  'gitsubmodule',
  'helm',
  'nix',
  'opentofu',
  'pre-commit',
  'terraform',
  'vcpkg',
])

const SEMVER_COOLDOWN_KEY = /^(semver-(?:major|minor|patch)-days)\s*:/

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function stripComment(line: string): string {
  const hash = line.indexOf('#')
  return hash === -1 ? line : line.slice(0, hash)
}

/**
 * Detect `semver-*-days` cooldown keys under ecosystems that do not support them.
 * Scoping matters in both directions: npm legitimately carries `semver-major-days`,
 * so a whole-file match would flag a valid config; each key must be attributed to
 * the `- package-ecosystem:` list item that contains it.
 * Hand-parsed — no YAML parser is available to this plugin.
 */
export function detectDependabotCooldownViolations(content: string): DependabotCooldownFinding[] {
  const lines = content.split('\n').map(stripComment)
  const starts: number[] = []
  lines.forEach((line, i) => {
    if (/^\s*-\s*package-ecosystem\s*:/.test(line)) starts.push(i)
  })

  const findings: DependabotCooldownFinding[] = []
  for (let b = 0; b < starts.length; b++) {
    const block = lines.slice(starts[b], starts[b + 1] ?? lines.length)
    const ecosystem = block[0].match(/package-ecosystem\s*:\s*['"]?([\w-]+)/)?.[1]
    if (!ecosystem || !SEMVER_COOLDOWN_UNSUPPORTED.has(ecosystem)) continue

    let cooldownIndent: number | null = null
    for (const line of block) {
      if (!line.trim()) continue
      if (cooldownIndent !== null && indentOf(line) <= cooldownIndent) cooldownIndent = null
      if (/^\s*cooldown\s*:/.test(line)) {
        cooldownIndent = indentOf(line)
        continue
      }
      if (cooldownIndent === null) continue
      const key = line.trim().match(SEMVER_COOLDOWN_KEY)?.[1]
      if (key) findings.push({ ecosystem, property: key })
    }
  }
  return findings
}

export function checkSecurity(): Section {
  const checks: Check[] = []

  // trufflehog binary
  const trufflehogInstalled = spawnSync(['which', 'trufflehog']).ok
  checks.push({
    name: 'trufflehog',
    status: trufflehogInstalled ? 'pass' : 'warn',
    detail: trufflehogInstalled
      ? 'installed'
      : 'not installed — pre-commit hook will fail. Install: brew install trufflehog or https://github.com/trufflesecurity/trufflehog/releases',
  })

  // .github/dependabot.yml — require ecosystem + github-actions (partial = fail)
  const dependabotPath = '.github/dependabot.yml'
  const dependabotExists = fs.existsSync(dependabotPath)
  if (!dependabotExists) {
    checks.push({
      name: 'dependabot.yml',
      status: 'warn',
      detail: 'missing — run /init or /ci-setup to create (automated dependency updates)',
    })
  } else {
    const depYml = fs.readFileSync(dependabotPath, 'utf8') as string
    const hasGha = /package-ecosystem:\s*github-actions/.test(depYml)
    const hasApp = /package-ecosystem:\s*(npm|pip)/.test(depYml)
    const cooldownViolations = detectDependabotCooldownViolations(depYml)
    if (cooldownViolations.length > 0) {
      const offenders = [...new Set(cooldownViolations.map((v) => `${v.property} under '${v.ecosystem}'`))].join(', ')
      checks.push({
        name: 'dependabot.yml',
        status: 'fail',
        detail: `invalid cooldown property: ${offenders} — GitHub rejects the entire dependabot.yml at parse time, so every ecosystem's update-types split silently stops applying. Keep only default-days there.`,
      })
    } else if (hasGha && hasApp) {
      checks.push({
        name: 'dependabot.yml',
        status: 'pass',
        detail: 'found (ecosystem + github-actions)',
      })
    } else {
      checks.push({
        name: 'dependabot.yml',
        status: 'warn',
        detail: `partial — missing ${!hasApp ? 'npm|pip ecosystem' : ''}${!hasApp && !hasGha ? ' and ' : ''}${!hasGha ? 'github-actions' : ''} block — re-run /ci-setup (generator owns full file)`,
      })
    }
  }

  // lock file + license checker — inferred from stack.yml package_manager
  let lockFile: string | null = null
  let licenseChecker: string | null = null
  let pm = ''
  try {
    pm = readParsedStack().packageManager ?? ''
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
  const hasLefthook = fs.existsSync(lefthookPath)
  if (hasLefthook) {
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

  // trufflehog in pre-commit (if .pre-commit-config.yaml present — Python repos)
  const preCommitPath = '.pre-commit-config.yaml'
  if (fs.existsSync(preCommitPath)) {
    const preCommitContent = fs.readFileSync(preCommitPath, 'utf8') as string
    const hasTrufflehog = preCommitContent.includes('trufflehog')
    checks.push({
      name: 'trufflehog in pre-commit',
      status: hasTrufflehog ? 'pass' : 'warn',
      detail: hasTrufflehog
        ? 'configured in .pre-commit-config.yaml'
        : 'not found in .pre-commit-config.yaml — add the trufflehog hook',
    })
  } else if (!hasLefthook) {
    checks.push({
      name: 'pre-commit hooks',
      status: 'warn',
      detail: 'no lefthook.yml or .pre-commit-config.yaml — secrets can reach git without local scanning',
    })
  }

  // trufflehog in CI — convention is pre-commit AND CI (a hook is skippable locally)
  const wfDir = '.github/workflows'
  if (fs.existsSync(wfDir)) {
    const wfFiles = (fs.readdirSync(wfDir) as string[]).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    const inCI = wfFiles.some((f) => {
      try {
        return /trufflehog|gitleaks/i.test(fs.readFileSync(`${wfDir}/${f}`, 'utf8') as string)
      } catch {
        return false
      }
    })
    checks.push({
      name: 'trufflehog in CI',
      status: inCI ? 'pass' : 'warn',
      detail: inCI
        ? 'secret scan present in CI workflows (content presence; required-check enforcement is reported under Branch protection)'
        : 'no CI workflow runs trufflehog/gitleaks — hooks alone are skippable (--no-verify)',
    })
  }

  return { name: 'Security', checks }
}

export interface PrTargetFinding {
  file: string
  checkout: 'none' | 'default' | 'pr-head'
}

/**
 * Detect the pull_request_target footgun: the trigger runs with secrets and a
 * write token on the BASE repo, so checking out (and executing) PR-head code
 * hands both to the PR author. PR-head code can arrive four ways: an explicit
 * PR-head ref on checkout, a fork checkout via repository:, the synthetic
 * refs/pull/N/merge ref, or a raw `git fetch/checkout` in a run: step.
 * Checkout of the default ref is suspicious but survivable; PR-head is not.
 */
export function detectPullRequestTargetCheckout(content: string, filePath: string): PrTargetFinding | null {
  const hasTrigger =
    /^\s*pull_request_target\s*:/m.test(content) ||
    /^on\s*:\s*\[[^\]]*pull_request_target[^\]]*\]/m.test(content) ||
    /\bon\s*:\s*\{[^}]*pull_request_target/.test(content)
  if (!hasTrigger) return null
  const executesPrHead =
    /ref:\s*\$\{\{\s*github\.(event\.pull_request\.head\.(sha|ref)|head_ref)\s*\}\}/.test(content) ||
    /repository:\s*\$\{\{\s*github\.event\.pull_request\.head\.repo\.full_name\s*\}\}/.test(content) ||
    /ref:\s*refs\/pull\/[^\n]*\/merge/.test(content) ||
    // code-fetching forms only: pull/${{N}}/head, refs/pull/*, or head.* fields —
    // a bare github.event.pull_request.title/number next to an unrelated git fetch is not a PR-head checkout
    /git\s+(fetch|checkout)[^\n]*(pull\/\$\{\{|refs\/pull\/|github\.event\.pull_request\.head)/.test(content)
  if (executesPrHead) return { file: filePath, checkout: 'pr-head' }
  if (content.includes('actions/checkout')) return { file: filePath, checkout: 'default' }
  return { file: filePath, checkout: 'none' }
}

export function checkPullRequestTarget(): Section {
  const wfDir = '.github/workflows'
  if (!fs.existsSync(wfDir))
    return {
      name: 'pull_request_target',
      checks: [{ name: 'pull_request_target', status: 'skip', detail: 'no local workflow files found' }],
    }

  const checks: Check[] = []
  for (const f of fs.readdirSync(wfDir) as string[]) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue
    let content: string
    try {
      content = fs.readFileSync(`${wfDir}/${f}`, 'utf8') as string
    } catch {
      checks.push({ name: f, status: 'warn', detail: 'could not read file — skipped' })
      continue
    }
    const finding = detectPullRequestTargetCheckout(content, f)
    if (!finding) continue
    if (finding.checkout === 'pr-head') {
      checks.push({
        name: f,
        status: 'fail',
        detail:
          'pull_request_target checks out or fetches PR-head code — untrusted code runs with secrets + write token. Switch to pull_request or drop the PR-head ref.',
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

export function checkVercel(): Section {
  const checks: Check[] = []

  const vercelExists = fs.existsSync('.vercel/project.json')
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

export function checkStandardsPaths(): Section {
  const checks: Check[] = []

  if (!fs.existsSync('.claude/stack.yml')) {
    return { name: 'Standards', checks: [{ name: 'stack.yml', status: 'skip', detail: 'not found' }] }
  }

  try {
    const standardsMap: Record<string, string> = readParsedStack().standards ?? {}

    for (const [key, trimmedPath] of Object.entries(standardsMap)) {
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

    if (checks.length === 0) {
      checks.push({ name: 'standards', status: 'skip', detail: 'no standards paths configured in stack.yml' })
    }
  } catch {
    checks.push({ name: 'standards', status: 'skip', detail: 'could not parse stack.yml' })
  }

  return { name: 'Standards', checks }
}
