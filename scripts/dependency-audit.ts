#!/usr/bin/env bun

/**
 * Dependency vulnerability audit for this repo (#645, ADR-022).
 *
 * GitHub's dependency graph does not parse bun.lock, and the bun Dependabot
 * ecosystem has no security updates, so `bun audit` is the only detection.
 * `.github/workflows/dependency-audit.yml` runs this weekly. Locally:
 * `bun run audit:deps`.
 *
 * Exit codes — the workflow routes on these, never on bun's own:
 *   0   clean: no finding, no stale ignore, every package audited
 *   10  action required: report written (findings, stale ignores and/or unaudited packages)
 *   2   the audit cannot be trusted: nothing is reported, nothing is filed
 *
 * Why bun's exit code is not enough: `bun audit --json` exits 1 both on findings
 * and on an error (a missing lockfile prints nothing on stdout), and `--ignore`
 * changes only the exit code — the JSON still lists ignored advisories. So the
 * ignore list is applied here, against the full report, which is also what
 * makes a stale entry detectable.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, writeFileSync } from 'node:fs'

export type Severity = 'low' | 'moderate' | 'high' | 'critical'

const SEVERITIES: readonly Severity[] = ['low', 'moderate', 'high', 'critical']

export interface Advisory {
  package: string
  /** GHSA id parsed from the advisory URL; null when the URL carries none. */
  ghsa: string | null
  url: string
  title: string
  severity: Severity
  vulnerableVersions: string
}

export interface Ignore {
  ghsa: string
  package: string
  /** Severity the advisory had when the ignore was accepted. A re-rated advisory is a finding again. */
  severity: Severity
  reason: string
  removeWhen: string
}

/** Accepted advisories. Each entry names why and when it goes; a stale entry is reported. */
export const IGNORED: readonly Ignore[] = [
  {
    ghsa: 'GHSA-g7r4-m6w7-qqqr',
    package: 'esbuild',
    severity: 'low',
    reason:
      "Windows-only file read from the esbuild dev server, reached via vitest → vite 7. The fix is esbuild 0.28.1, outside vite 7's range.",
    removeWhen: 'vite 8 lands (esbuild >= 0.28.1)',
  },
]

export class AuditOutputError extends Error {}

const GHSA_IN_URL = /\/(GHSA(?:-[0-9a-z]{4}){3})\/?$/

/** The ignore key. classify and renderReport must agree on it, or a re-rated advisory is mislabelled. */
function matches(a: Advisory, i: Ignore): boolean {
  return a.ghsa === i.ghsa && a.package === i.package
}

function isSeverity(value: unknown): value is Severity {
  return SEVERITIES.includes(value as Severity)
}

/**
 * Strict read of `bun audit --json`. Any shape other than
 * `{ <package>: [{ url, title, severity, … }, …] }` throws: an HTTP 200 error
 * body from the registry is echoed as JSON with exit 0, and must not read as clean.
 */
export function parseAudit(stdout: string): Advisory[] {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    throw new AuditOutputError(`bun audit printed no JSON: ${JSON.stringify(stdout.slice(0, 200))}`)
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AuditOutputError('bun audit JSON is not an object')
  }

  const advisories: Advisory[] = []
  for (const [pkg, entries] of Object.entries(data)) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new AuditOutputError(`bun audit entry "${pkg}" is not a non-empty array of advisories`)
    }
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) {
        throw new AuditOutputError(`bun audit entry "${pkg}" holds a non-object advisory`)
      }
      const { url, title, severity, vulnerable_versions } = entry as Record<string, unknown>
      if (typeof url !== 'string' || typeof title !== 'string' || !isSeverity(severity)) {
        throw new AuditOutputError(`bun audit advisory for "${pkg}" lacks a url, a title or a known severity`)
      }
      advisories.push({
        package: pkg,
        ghsa: GHSA_IN_URL.exec(url)?.[1] ?? null,
        url,
        title,
        severity,
        vulnerableVersions: typeof vulnerable_versions === 'string' ? vulnerable_versions : '',
      })
    }
  }
  return advisories
}

export interface Classified {
  findings: Advisory[]
  suppressed: Advisory[]
  stale: Ignore[]
  /** What bun says it skipped: packages whose registry did not answer the audit request. */
  unaudited: string[]
}

export function classify(
  advisories: readonly Advisory[],
  ignored: readonly Ignore[],
  unaudited: readonly string[] = [],
): Classified {
  const findings: Advisory[] = []
  const suppressed: Advisory[] = []
  for (const advisory of advisories) {
    const accepted = ignored.some((i) => matches(advisory, i) && i.severity === advisory.severity)
    ;(accepted ? suppressed : findings).push(advisory)
  }
  const stale = ignored.filter((i) => !advisories.some((a) => matches(a, i)))
  return { findings, suppressed, stale, unaudited: [...unaudited] }
}

/** Order-independent identity of a report: the workflow comments only when it changes. */
export function marker(c: Classified): string {
  const ids = [
    ...c.findings.map((a) => `${a.ghsa ?? a.url}:${a.severity}`),
    ...c.stale.map((i) => `stale:${i.ghsa}`),
    ...c.unaudited.map((u) => `unaudited:${createHash('sha256').update(u).digest('hex').slice(0, 12)}`),
  ]
  return [...new Set(ids)].sort().join(',')
}

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const SKIPPED = /did not answer the audit request(?: \([^)]*\))?; skipped (.+)$/

/**
 * Packages bun could not audit. bun reports them only as a stderr warning (a registry
 * that did not answer the audit request); they change neither its exit code nor its JSON,
 * so without this a skipped package reads as a clean one.
 */
function skippedPackages(stderr: string): string[] {
  return stderr
    .replace(ANSI, '')
    .split('\n')
    .flatMap((line) => SKIPPED.exec(line.trim())?.[1] ?? [])
}

export interface RunMeta {
  ref: string
  sha: string
  runUrl: string | null
  bunVersion: string
}

function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').trim()
}

export function renderReport(c: Classified, ignored: readonly Ignore[], meta: RunMeta): string {
  const lines = [`<!-- dependency-audit: ${marker(c)} -->`, '## Dependency audit: action required', '']

  if (c.findings.length > 0) {
    const findings = [...c.findings].sort(
      (a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.package.localeCompare(b.package),
    )
    const packages = new Set(findings.map((a) => a.package)).size
    lines.push(
      `**Highest severity: ${findings[0].severity}** — ${findings.length} advisory(ies) in ${packages} package(s).`,
      '',
      '| Package | Severity | Advisory | Title | Vulnerable versions |',
      '|---|---|---|---|---|',
    )
    for (const a of findings) {
      const accepted = ignored.find((i) => matches(a, i))
      const title = accepted ? `${a.title} (ignored at ${accepted.severity}, re-rated)` : a.title
      // Link built from the parsed id, never from the advisory's own url field.
      const advisory = a.ghsa ? `[${a.ghsa}](https://github.com/advisories/${a.ghsa})` : cell(a.url)
      lines.push(
        `| ${cell(a.package)} | ${a.severity} | ${advisory} | ${cell(title)} | ${cell(a.vulnerableVersions)} |`,
      )
    }
    lines.push(
      '',
      'Fix: in a worktree, `bun audit fix` (within declared ranges) or `bun audit fix --latest` (crosses majors), then a PR.',
      'Accept instead: add the advisory to `IGNORED` in `scripts/dependency-audit.ts`, with its reason and removal condition.',
      '',
    )
  } else {
    lines.push('No vulnerable package.', '')
  }

  if (c.unaudited.length > 0) {
    lines.push(
      '### Unaudited packages',
      '',
      'bun skipped these because their registry did not answer the audit request. They may carry advisories:',
      '',
      ...c.unaudited.map((u) => `- ${cell(u)}`),
      '',
    )
  }

  if (c.stale.length > 0) {
    lines.push(
      '### Stale ignores',
      '',
      'These entries of `IGNORED` in `scripts/dependency-audit.ts` no longer match the tree. Remove them:',
      '',
      ...c.stale.map((i) => `- \`${i.ghsa}\` (${i.package}) — planned removal: ${i.removeWhen}`),
      '',
    )
  }

  lines.push(
    `Ref \`${meta.ref}\` · \`${meta.sha.slice(0, 8)}\` · bun ${meta.bunVersion}${meta.runUrl ? ` · [run](${meta.runUrl})` : ''}`,
    '',
  )
  return lines.join('\n')
}

function reportPath(argv: readonly string[]): string | null {
  if (argv.length === 0) return null
  if (argv.length === 2 && argv[0] === '--report' && argv[1] !== '') return argv[1]
  throw new AuditOutputError(`usage: dependency-audit.ts [--report <path>] (got: ${argv.join(' ')})`)
}

function runMeta(env: NodeJS.ProcessEnv): RunMeta {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = env
  return {
    ref: env.GITHUB_REF_NAME ?? 'local',
    sha: env.GITHUB_SHA ?? 'local',
    runUrl: server && repo && run ? `${server}/${repo}/actions/runs/${run}` : null,
    bunVersion: Bun.version,
  }
}

/** One bulk audit request; the job's own 10-minute cap is the backstop, not the bound. */
const AUDIT_TIMEOUT_MS = 120_000

export function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): number {
  try {
    const path = reportPath(argv)
    const audit = Bun.spawnSync([process.execPath, 'audit', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: AUDIT_TIMEOUT_MS,
    })
    const stderr = audit.stderr.toString()
    process.stderr.write(stderr)
    // bun audit finishes with 0 (nothing found) or 1 (findings, or an error it prints).
    // A signal — the timeout included — can leave already-flushed JSON behind: not finished.
    if (audit.signalCode || (audit.exitCode !== 0 && audit.exitCode !== 1)) {
      throw new AuditOutputError(`bun audit did not finish: ${audit.signalCode ?? `exit ${audit.exitCode}`}`)
    }
    const advisories = parseAudit(audit.stdout.toString())
    // bun exits 0 exactly when it reports nothing. Any other pairing means one of the two lies.
    if ((advisories.length === 0) !== (audit.exitCode === 0)) {
      throw new AuditOutputError(`bun audit exited ${audit.exitCode} with ${advisories.length} advisory(ies)`)
    }

    const result = classify(advisories, IGNORED, skippedPackages(stderr))
    if (result.findings.length === 0 && result.stale.length === 0 && result.unaudited.length === 0) {
      const summary = `Dependency audit: clean — ${result.suppressed.length} ignored advisory(ies) (bun ${Bun.version}).\n`
      if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary)
      process.stdout.write(summary)
      return 0
    }

    const report = renderReport(result, IGNORED, runMeta(env))
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, report)
    if (path) writeFileSync(path, report)
    else process.stdout.write(report)
    console.error(
      `dependency-audit: ${result.findings.length} finding(s), ${result.stale.length} stale ignore(s), ${result.unaudited.length} unaudited`,
    )
    return 10
  } catch (error) {
    console.error(`dependency-audit: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)))
