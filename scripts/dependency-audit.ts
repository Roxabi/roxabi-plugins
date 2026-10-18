#!/usr/bin/env bun

/**
 * Dependency vulnerability audit for this repo (#645, ADR-022).
 *
 * GitHub's dependency graph lists no manifest for this repo (#648) and the bun
 * Dependabot ecosystem has no security updates, so `bun audit` is the only
 * detection for npm packages.
 * `.github/workflows/dependency-audit.yml` runs this weekly. Locally:
 * `bun scripts/dependency-audit.ts` (a file, not a package.json script: `bun run` would
 * put node_modules/.bin first on PATH, and the audit must run on the bun you chose).
 *
 * The workflow runs this only on a `bun.lock` that matches `package.json`: `bun audit`
 * reads the lock alone, so a dependency missing from it would never be audited. A
 * mismatch is routed like exit 2.
 *
 * Exit codes — the workflow routes on these, never on bun's own:
 *   0   clean: no finding, no stale ignore, every package audited. Nothing is filed.
 *   10  action required: report written (findings, stale ignores and/or unaudited
 *       packages). The workflow files or updates the `security` issue; if that write
 *       fails, it files the "audit failed" issue below instead. An unaudited package is
 *       an incomplete audit, not a vulnerability; it is routed here on purpose, because
 *       reading it as clean is the false clean this script exists to stop.
 *   2   the audit cannot be trusted: no report. The workflow files the non-security
 *       "dependency audit: audit failed" issue and the run stays red; any other
 *       non-zero code is routed the same way, and so is a run that fails or is
 *       cancelled before this script finishes. The next run that delivers its result
 *       (clean, or filed as the security issue) closes it.
 *
 * Still no signal: a scheduled run GitHub drops or disables (the schedule is
 * best-effort, and turns off after 60 days without repository activity), a run whose
 * last step cannot write to GitHub, and a registry that answers `{}` for packages it
 * never audited.
 *
 * Why bun's exit code is not enough: `bun audit --json` exits 1 both on findings
 * and on an error (a missing lockfile prints nothing on stdout), and `--ignore`
 * changes only the exit code — the JSON still lists ignored advisories. So the
 * ignore list is applied here, against the full report, which is also what
 * makes a stale entry detectable.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, writeFileSync, writeSync } from 'node:fs'

export type Severity = 'low' | 'moderate' | 'high' | 'critical'

const SEVERITIES: readonly Severity[] = ['low', 'moderate', 'high', 'critical']

export interface Advisory {
  package: string
  /** GHSA id parsed from the advisory URL; null when the URL carries none. */
  ghsa: string | null
  /** bun's advisory id when it is a positive safe integer, the only id a flag is built from; else null. */
  id: number | null
  /** The id text bun's `--ignore` compares (see `bunIdText`): what bun derives from the `id` field, '' when it derives none. */
  bunId: string
  url: string
  title: string
  severity: Severity
  vulnerableVersions: string
}

/** An advisory `classify` suppressed: it matched an `Ignore`, so it has a GHSA. */
export type Accepted = Advisory & { ghsa: string }

export interface Ignore {
  ghsa: string
  package: string
  /** Severity the advisory had when the ignore was accepted. A re-rated advisory is a finding again. */
  severity: Severity
  reason: string
  removeWhen: string
}

/** Accepted advisories. Each entry names why and when it goes; a stale entry is reported. */
export const IGNORED: readonly Ignore[] = []

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
 * The id text bun derives from an advisory's `id` field, as `parse_vulnerability` does in
 * bun's `src/runtime/cli/audit_command.rs` (tags bun-v1.4.0 and bun-v1.4.3): a string is kept
 * verbatim, a number becomes `format!("{}", num as u64)`, anything else or missing is empty.
 * Rust's `f64 as u64` saturates: NaN and negatives give 0, a fraction truncates, 2^64 and
 * above give u64::MAX.
 */
function bunIdText(id: unknown): string {
  if (typeof id === 'string') return id
  if (typeof id !== 'number') return ''
  if (!(id > 0)) return '0'
  if (id >= 2 ** 64) return '18446744073709551615'
  return BigInt(Math.trunc(id)).toString()
}

/**
 * JSON.parse keeps the last duplicate key; bun's typed property walk can retain an earlier
 * value instead. Accept only unambiguous objects rather than emulate that disagreement.
 * The input has already passed JSON.parse, so this scan only tracks object keys, skipping
 * complete string values and keeping separate key sets for nested objects and arrays.
 */
function assertUniqueObjectKeys(source: string): void {
  const stack: ({ keys: Set<string>; expectingKey: boolean } | null)[] = []
  for (let offset = 0; offset < source.length; offset++) {
    const character = source[offset]
    if (character === '"') {
      let end = offset + 1
      for (; end < source.length; end++) {
        if (source[end] === '\\') end++
        else if (source[end] === '"') break
      }
      const object = stack.at(-1)
      if (object?.expectingKey) {
        const key: string = JSON.parse(source.slice(offset, end + 1))
        if (object.keys.has(key)) {
          throw new AuditOutputError(`bun audit JSON repeats object key ${JSON.stringify(key)}`)
        }
        object.keys.add(key)
        object.expectingKey = false
      }
      offset = end
    } else if (character === '{') {
      stack.push({ keys: new Set(), expectingKey: true })
    } else if (character === '[') {
      stack.push(null)
    } else if (character === '}' || character === ']') {
      stack.pop()
    } else if (character === ',') {
      const object = stack.at(-1)
      if (object) object.expectingKey = true
    }
  }
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
  assertUniqueObjectKeys(stdout)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new AuditOutputError('bun audit JSON is not an object')
  }

  const advisories: Advisory[] = []
  // Registry text goes into messages JSON-quoted: a raw newline would start a new line in
  // the Actions log, which the runner parses as a workflow command.
  for (const [pkg, entries] of Object.entries(data)) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new AuditOutputError(`bun audit entry ${JSON.stringify(pkg)} is not a non-empty array of advisories`)
    }
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null) {
        throw new AuditOutputError(`bun audit entry ${JSON.stringify(pkg)} holds a non-object advisory`)
      }
      const { id, url, title, severity, vulnerable_versions } = entry as Record<string, unknown>
      if (typeof url !== 'string' || typeof title !== 'string' || !isSeverity(severity)) {
        throw new AuditOutputError(
          `bun audit advisory for ${JSON.stringify(pkg)} lacks a url, a title or a known severity`,
        )
      }
      advisories.push({
        package: pkg,
        ghsa: GHSA_IN_URL.exec(url)?.[1] ?? null,
        id: typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null,
        bunId: bunIdText(id),
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
  suppressed: Accepted[]
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
  const suppressed: Accepted[] = []
  for (const advisory of advisories) {
    // `matches` needs a GHSA on both sides, so an accepted advisory always has one.
    if (advisory.ghsa !== null && ignored.some((i) => matches(advisory, i) && i.severity === advisory.severity)) {
      suppressed.push({ ...advisory, ghsa: advisory.ghsa })
    } else {
      findings.push(advisory)
    }
  }
  const stale = ignored.filter((i) => !advisories.some((a) => matches(a, i)))
  return { findings, suppressed, stale, unaudited: [...unaudited] }
}

/** The advisory as one marker segment: its GHSA, else a hash of its url (registry text never enters verbatim). */
function advisoryToken(a: Advisory): string {
  return a.ghsa ?? `url-${createHash('sha256').update(a.url).digest('hex').slice(0, 12)}`
}

/**
 * What the report's `Fix:` command carries, or null when the report prints no `Fix:` line
 * (no finding). Acceptance is `classify`'s: the suppressed set; everything else in the audit
 * output is in `findings`, whatever its severity or classification.
 *
 * bun's `--ignore=<v>` spares an advisory when its id text equals `v` or its url contains
 * `v`, for every advisory of every package, in `bun audit` and `bun audit fix` alike
 * (`keep_vulnerability` and `parse_vulnerability` in `src/runtime/cli/audit_command.rs`,
 * tags bun-v1.4.0 and bun-v1.4.3; the id text is `bunId`). The command is computed against
 * that rule: `--ignore=<n>` is printed for an accepted advisory only when `n` is a positive
 * safe integer and no finding is spared by `String(n)`. An accepted advisory that gets no
 * flag (no such id, or its id would also spare a finding) is listed with the reason, and the
 * operator checks `bun audit fix --dry-run` and restores its `bun.lock` entry by hand. A GHSA
 * flag is never emitted: it would spare every package sharing the GHSA and any url holding it.
 */
interface NotSpared {
  advisory: Accepted
  /** Packages of the findings its id would also spare; empty when it has no usable id. */
  collidesWith: string[]
}

interface Remediation {
  /** Sorted numerically, deduplicated: one `--ignore=<id>` each. */
  ids: number[]
  /** Accepted advisories with no flag, one per package, GHSA and id text; sorted by package then GHSA. */
  notSpared: NotSpared[]
}

function remediation(c: Classified): Remediation | null {
  if (c.findings.length === 0) return null
  const ids = new Set<number>()
  const notSpared = new Map<string, NotSpared>()
  for (const advisory of c.suppressed) {
    const { id } = advisory
    const value = String(id)
    const colliding = id === null ? [] : c.findings.filter((f) => f.bunId === value || f.url.includes(value))
    if (id !== null && colliding.length === 0) {
      ids.add(id)
    } else {
      const key = `${advisory.package}\0${advisory.ghsa}\0${advisory.bunId}`
      notSpared.set(key, { advisory, collidesWith: [...new Set(colliding.map((f) => f.package))].sort() })
    }
  }
  return {
    ids: [...ids].sort((x, y) => x - y),
    notSpared: [...notSpared.values()].sort(
      (a, b) => a.advisory.package.localeCompare(b.advisory.package) || a.advisory.ghsa.localeCompare(b.advisory.ghsa),
    ),
  }
}

/**
 * Order-independent identity of a report: the workflow comments only when it changes.
 * It covers what the `Fix:` line depends on — a flag per accepted id, a key per accepted
 * advisory listed as not spared — but only on a report that prints that line: the open issue's
 * latest comment carries the command an operator copies, so a changed command must post a
 * new comment, while an accepted key changing under a report with no finding must not.
 * Built from a restricted alphabet — registry text never reaches it verbatim, because the
 * workflow parses it back out of an HTML comment. Token kinds stay apart by prefix and by
 * the last segment: a finding ends in a severity, a stale or not-spared key in a GHSA.
 */
export function marker(c: Classified): string {
  const fix = remediation(c)
  const ids = [
    ...c.findings.map((a) => `${a.package}:${advisoryToken(a)}:${a.severity}`),
    ...c.stale.map((i) => `stale:${i.package}:${i.ghsa}`),
    ...c.unaudited.map((u) => `unaudited:${createHash('sha256').update(u).digest('hex').slice(0, 12)}`),
    ...(fix?.ids ?? []).map((id) => `ignore:${id}`),
    // The `idless:` kind keeps its name though an id that would spare a finding also lands here:
    // renaming it would change the identity of an open report and post one needless comment.
    // Still apart from the other kinds by its prefix and its GHSA last segment.
    ...(fix?.notSpared ?? []).map((n) => `idless:${n.advisory.package}:${n.advisory.ghsa}`),
  ]
  return [...new Set(ids.map((id) => id.replace(/[^A-Za-z0-9@/._:-]/g, '_')))].sort().join(',')
}

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const SKIPPED = /did not answer the audit request(?: \([^)]*\))?; skipped (.+)$/

/**
 * Packages bun could not audit. bun reports them only as a stderr warning (a registry
 * that did not answer the audit request); they change neither its exit code nor its JSON,
 * so without this a skipped package reads as a clean one. bun writes one line per
 * registry and joins its packages with `, ` — npm names contain neither.
 */
function skippedPackages(stderr: string): string[] {
  return stderr
    .replace(ANSI, '')
    .split('\n')
    .flatMap((line) => SKIPPED.exec(line.trim())?.[1].split(', ') ?? [])
}

export interface RunMeta {
  ref: string
  sha: string
  runUrl: string | null
  bunVersion: string
}

/**
 * Registry text as one inline code span. GitHub renders nothing inside one — no link,
 * image, @-mention, autolink or HTML — so an advisory can neither pose as a GHSA link nor
 * ping anyone. The fence is one backtick longer than any run inside, so none closes it
 * early; `|` stays escaped because GFM splits table cells before it parses code spans.
 * A `\` needs no escape of its own: GFM reads a `|` right after any `\` as cell text.
 */
function code(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|')
  const fence = '`'.repeat(Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length)) + 1)
  return `${fence} ${flat} ${fence}`
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
      const title = code(a.title) + (accepted ? ` (ignored at ${accepted.severity}, re-rated)` : '')
      // Link built from the parsed id, never from the advisory's own url field.
      const advisory = a.ghsa ? `[${a.ghsa}](https://github.com/advisories/${a.ghsa})` : code(a.url)
      lines.push(`| ${code(a.package)} | ${a.severity} | ${advisory} | ${title} | ${code(a.vulnerableVersions)} |`)
    }
    const fix = remediation(c)
    const command = ['bun audit fix', ...(fix?.ids ?? []).map((id) => `--ignore=${id}`)].join(' ')
    lines.push(
      '',
      `Fix: in a worktree, \`${command}\` (within declared ranges) or \`${command} --latest\` (crosses majors), then a PR.`,
    )
    for (const { advisory, collidesWith } of fix?.notSpared ?? []) {
      // The GHSA is parsed against a strict pattern, so it prints bare; package names are registry text.
      const why =
        collidesWith.length === 0
          ? 'bun sent no usable advisory id for it (a positive whole number)'
          : `its id ${advisory.id} would also spare ${collidesWith.map(code).join(', ')}, since bun matches an --ignore value against every advisory's id and url`
      lines.push(
        `Not spared by that command: ${code(advisory.package)} (${advisory.ghsa}) is accepted, but ${why}, so the command carries no flag for it. Check \`bun audit fix --dry-run\` before running it, and restore that package's entry in \`bun.lock\` by hand if it moves.`,
      )
    }
    lines.push(
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
      ...c.unaudited.map((u) => `- ${code(u)}`),
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
    // The ref is a branch name anyone who can dispatch picks, and git allows backticks in it.
    `Ref ${code(meta.ref)} · ${code(meta.sha.slice(0, 8))} · bun ${meta.bunVersion}${meta.runUrl ? ` · [run](${meta.runUrl})` : ''}`,
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

/**
 * One bulk audit request. Well inside the audit step's 6-minute cap, so a hung audit ends
 * in exit 2 and the failure issue carries an exit code; the step cap is only the backstop.
 */
const AUDIT_TIMEOUT_MS = 120_000

function appendStepSummary(env: NodeJS.ProcessEnv, text: string): void {
  if (!env.GITHUB_STEP_SUMMARY) return
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, text)
  } catch (error) {
    console.error(
      `dependency-audit: step summary not written: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Display only, like the step summary: a closed or full stdout must not turn 0 or 10 into 2.
 * A non-blocking stdout can take part of a write, so the rest is written until a call takes
 * nothing or throws.
 */
function writeStdout(text: string): void {
  const bytes = Buffer.from(text)
  let written = 0
  try {
    while (written < bytes.length) {
      const n = writeSync(1, bytes, written)
      if (!(n > 0)) throw new Error(`write returned ${n}`)
      written += n
    }
  } catch (error) {
    console.error(
      `dependency-audit: stdout not written (${written} of ${bytes.length} bytes): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  ignored: readonly Ignore[] = IGNORED,
): number {
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

    const result = classify(advisories, ignored, skippedPackages(stderr))
    if (result.findings.length === 0 && result.stale.length === 0 && result.unaudited.length === 0) {
      const summary = `Dependency audit: clean — ${result.suppressed.length} ignored advisory(ies) (bun ${Bun.version}).\n`
      writeStdout(summary)
      appendStepSummary(env, summary)
      return 0
    }

    // The report file is the workflow's input: write it first, inside the try. Stdout and
    // the step summary are display only and must never change the code the workflow routes on.
    const report = renderReport(result, ignored, runMeta(env))
    if (path) writeFileSync(path, report)
    else writeStdout(report)
    appendStepSummary(env, report)
    console.error(
      `dependency-audit: ${result.findings.length} finding(s), ${result.stale.length} stale ignore(s), ${result.unaudited.length} unaudited`,
    )
    return 10
  } catch (error) {
    console.error(`dependency-audit: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

// exitCode, not exit(): exit() can cut a piped stdout short.
if (import.meta.main) process.exitCode = main(process.argv.slice(2))
