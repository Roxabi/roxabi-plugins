import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { applyUsage, identity, inspectRegistered, token } from './worktree-inspection'
import {
  canonical,
  command,
  excludedDirectories,
  git,
  inside,
  message,
  type Options,
  type Report,
  type Row,
  scanner,
} from './worktree-shared'

function discover(root: string, found: string[], errors: Report['errors']) {
  let path: string
  try {
    path = canonical(root)
    if (path !== resolve(root)) throw new Error('discovery root contains a symlink')
    if (!statSync(path).isDirectory()) throw new Error('not a directory')
  } catch (e) {
    errors.push({ path: root, message: message(e) })
    return
  }
  function walk(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      if (
        entries.some((e) => e.name === '.git') ||
        (entries.some((e) => e.name === 'HEAD') &&
          entries.some((e) => e.name === 'objects') &&
          entries.some((e) => e.name === 'refs'))
      )
        found.push(dir)
      for (const entry of entries)
        if (entry.isDirectory() && !excludedDirectories.includes(entry.name)) walk(join(dir, entry.name))
    } catch (e) {
      errors.push({ path: dir, message: message(e) })
    }
  }
  walk(path)
}
function collectRegisteredRow(
  report: Report,
  record: Record<string, string>,
  index: number,
  principal: string,
  common: string,
  repo: string,
  allPaths: string[],
  options: Options,
) {
  const path = resolve(record.worktree)
  const branch = record.branch?.replace(/^refs\/heads\//, '') || null
  if (options.scope && (!branch || !new RegExp(`(?:^|[/-])${options.scope}(?:$|[/_-])`).test(branch))) return
  const row: Row = {
    repository: principal,
    commonDir: common,
    path,
    branch,
    head: record.HEAD || null,
    kind: record.bare !== undefined ? 'bare' : record.detached !== undefined ? 'detached' : 'registered',
    localChanges: null,
    ignoredEntries: [],
    requiresArtifactConfirmation: false,
    activity: 'unknown',
    requiresUsageConfirmation: false,
    warnings: [],
    usageEvidence: [],
    eligible: false,
    reasons: [],
    token: '',
  }
  let id: unknown = null
  if (index === 0) row.reasons.push('principal worktree')
  if (record.locked !== undefined) row.reasons.push('locked worktree')
  if (record.prunable !== undefined) row.reasons.push('prunable worktree; inspect manually')
  if (record.bare !== undefined) row.reasons.push('bare repository')
  if (inside(path, resolve(process.cwd()))) row.reasons.push('current directory is inside worktree')
  if (allPaths.some((other) => other !== path && inside(path, other)))
    row.reasons.push('contains another registered worktree')
  try {
    id = inspectRegistered(row, record, repo)
  } catch (e) {
    row.reasons.push(message(e))
    report.errors.push({ path, message: message(e), scope: 'worktree' })
  }
  row.eligible = row.reasons.length === 0
  row.token = token(row, id)
  report.worktrees.push(row)
}
function collectRegistered(
  report: Report,
  records: Record<string, string>[],
  principal: string,
  common: string,
  repo: string,
  allPaths: string[],
  options: Options,
) {
  for (let index = 0; index < records.length; index++) {
    collectRegisteredRow(report, records[index], index, principal, common, repo, allPaths, options)
  }
}
function collectOrphan(report: Report, line: string, principal: string, common: string, allPaths: string[]) {
  const parts = line.split('|')
  if (parts.length < 3) throw new Error('malformed orphan scanner output')
  const [path, kind, ...details] = parts
  const row: Row = {
    repository: principal,
    commonDir: common,
    path,
    branch: null,
    head: null,
    kind,
    localChanges: null,
    ignoredEntries: [],
    requiresArtifactConfirmation: false,
    activity: 'unknown',
    requiresUsageConfirmation: false,
    warnings: [],
    usageEvidence: [],
    eligible: false,
    reasons: [],
    token: '',
    detail: details.join('|'),
  }
  let id: unknown = null
  if (!['empty_parent', 'empty_untracked'].includes(kind))
    row.reasons.push('orphan classification requires preservation')
  if (!isAbsolute(path) || resolve(path) !== path) row.reasons.push('unsupported scanner path')
  if (inside(path, resolve(process.cwd()))) row.reasons.push('current directory is inside worktree')
  if (allPaths.some((other) => inside(path, other))) row.reasons.push('contains a registered worktree')
  if (!row.reasons.length) {
    try {
      id = identity(path)
      if (readdirSync(path).length) row.reasons.push('orphan is not empty')
      applyUsage(row)
    } catch (e) {
      row.reasons.push(message(e))
      report.errors.push({ path, message: message(e), scope: 'worktree' })
    }
  }
  row.eligible = row.reasons.length === 0
  row.token = token(row, id)
  report.worktrees.push(row)
}
function collectOrphans(report: Report, repo: string, principal: string, common: string, allPaths: string[]) {
  const firstOrphan = report.worktrees.length
  try {
    const output = command('bash', [scanner], repo)
    for (const line of output.split('\n').filter(Boolean)) collectOrphan(report, line, principal, common, allPaths)
  } catch (e) {
    report.errors.push({ path: repo, message: `orphan scan: ${message(e)}`, scope: 'orphan-scan' })
    for (const row of report.worktrees.slice(firstOrphan)) {
      row.eligible = false
      row.reasons.push('orphan scan incomplete')
    }
  }
}
function registeredRecords(repo: string): Record<string, string>[] {
  const records: Record<string, string>[] = []
  let record: Record<string, string> = {}
  for (const chunk of git(repo, 'worktree', 'list', '--porcelain', '-z').split('\0')) {
    if (!chunk) {
      if (record.worktree) records.push(record)
      record = {}
      continue
    }
    const pos = chunk.indexOf(' ')
    record[pos < 0 ? chunk : chunk.slice(0, pos)] = pos < 0 ? '' : chunk.slice(pos + 1)
  }
  if (record.worktree) records.push(record)
  if (!records.length) throw new Error('git returned no worktrees')
  return records
}
function collectRepository(report: Report, candidate: string, seen: Set<string>, options: Options) {
  let repo: string, common: string
  try {
    repo = canonical(candidate)
    common = canonical(git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').replace(/\n$/, ''))
  } catch (e) {
    report.errors.push({ path: candidate, message: message(e), scope: 'repository' })
    return
  }
  if (seen.has(common)) return
  seen.add(common)
  let records: Record<string, string>[]
  try {
    records = registeredRecords(repo)
  } catch (e) {
    report.errors.push({ path: repo, message: message(e), scope: 'repository' })
    return
  }
  const allPaths = records.map((r) => resolve(r.worktree))
  const principal = allPaths[0]
  report.repositories.push({ path: principal, commonDir: common })
  const unsupportedScannerPaths = [repo, common, ...allPaths].some((path) => path.includes('\n') || path.includes('\r'))
  if (unsupportedScannerPaths)
    report.errors.push({
      path: repo,
      message: 'orphan scanner cannot safely inspect repository or worktree paths containing newlines',
      scope: 'orphan-scan',
    })
  collectRegistered(report, records, principal, common, repo, allPaths, options)
  if (!options.scope && !unsupportedScannerPaths) collectOrphans(report, repo, principal, common, allPaths)
}
function inventory(options: Options): Report {
  const report: Report = {
    version: 1,
    repositories: [],
    worktrees: [],
    errors: [],
    discoveryExclusions: { directoryNames: excludedDirectories, symlinks: 'not followed' },
  }
  const candidates = [...options.repos]
  for (const root of options.roots) discover(root, candidates, report.errors)
  if (!candidates.length && !options.roots.length) candidates.push(process.cwd())
  const seen = new Set<string>()
  for (const candidate of candidates.sort()) collectRepository(report, candidate, seen, options)
  report.repositories.sort((a, b) => a.path.localeCompare(b.path))
  report.worktrees.sort((a, b) => a.path.localeCompare(b.path))
  report.errors.sort((a, b) => a.path.localeCompare(b.path) || a.message.localeCompare(b.message))
  return report
}

export { inventory }
