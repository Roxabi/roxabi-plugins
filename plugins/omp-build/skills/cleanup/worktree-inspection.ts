import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { inspectArtifactTrees } from './worktree-artifact-trees'
import { classifyIgnored } from './worktree-artifacts'
import { inspectForceTree } from './worktree-force'
import { type Changes, canonical, git, inside, type LocalEntry, message, type Row } from './worktree-shared'

type Activity = 'idle' | 'active' | 'unknown'
type Usage = { activity: Activity; evidence: string[]; warnings: string[] }
type Status = { raw: string; changes: Changes; ignored: string[]; entries: LocalEntry[] }
// Digests of the exact status output, index stages/object IDs, index flags and whole-tree metadata fingerprint.
type Evidence = { status: string; stage: string; flags: string; tree: string | null }
type Inspection = { id: unknown; evidence?: Evidence }
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
function inspectLink(link: string, path: string, label: string, usage: Usage) {
  try {
    const target = readlinkSync(link).replace(/ \(deleted\)$/, '')
    if (inside(path, target)) {
      usage.activity = 'active'
      usage.evidence.push(`${label}: ${target}`)
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (usage.activity !== 'active') usage.activity = 'unknown'
      usage.warnings.push(`${label}: ${message(e)}`)
    }
  }
}
function inspectProcess(proc: string, path: string, uid: number, usage: Usage) {
  try {
    const status = readFileSync(`${proc}/status`, 'utf8')
    const ids = status
      .match(/^Uid:\s+([^\n]+)/m)?.[1]
      .trim()
      .split(/\s+/)
      .map(Number)
    if (!ids) throw new Error('process UID unavailable')
    if (!ids.includes(uid)) return
    const name = status.match(/^Name:\s+([^\n]+)/m)?.[1] || 'unknown'
    const label = `${proc.slice(6)} ${name}`
    inspectLink(`${proc}/cwd`, path, `${label} cwd`, usage)
    for (const fd of readdirSync(`${proc}/fd`)) inspectLink(`${proc}/fd/${fd}`, path, `${label} fd ${fd}`, usage)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (usage.activity !== 'active') usage.activity = 'unknown'
      usage.warnings.push(`${proc}: ${message(e)}`)
    }
  }
}
function processActivity(path: string): Usage {
  const usage: Usage = { activity: 'idle', evidence: [], warnings: [] }
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    usage.activity = 'unknown'
    usage.warnings.push('same-user process inspection is unsupported on this platform')
    return usage
  }
  try {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue
      inspectProcess(`/proc/${pid}`, path, process.getuid(), usage)
    }
  } catch (e) {
    usage.activity = 'unknown'
    usage.warnings.push(`/proc: ${message(e)}`)
  }
  return usage
}
function applyUsage(row: Row) {
  const usage = processActivity(row.path)
  row.activity = usage.activity
  row.warnings = usage.warnings
  row.usageEvidence = usage.evidence
  row.requiresUsageConfirmation = usage.activity === 'unknown'
  if (usage.activity === 'active') row.reasons.push('used by a same-user process')
}
// With `-z`, a rename or copy record is followed by its source path as a separate field.
function statusEntry(fields: string[], index: number): LocalEntry {
  const entry: LocalEntry = { status: fields[index].slice(0, 2), path: fields[index].slice(3) }
  if (!entry.status.includes('R') && !entry.status.includes('C')) return entry
  const originalPath = fields[index + 1]
  if (!originalPath) throw new Error('git status rename or copy record lacks its source path')
  entry.originalPath = originalPath
  return entry
}
// One status pass yields the change counts, every record with its exact code and paths, and the worktree-relative paths
// Git reports as ignored. Git collapses an ignored directory into one entry with a trailing slash; its children are not
// listed.
function status(path: string): Status {
  const raw = git(path, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching')
  const fields = raw.split('\0')
  const observed: Status = { raw, changes: { tracked: 0, untracked: 0, ignored: 0 }, ignored: [], entries: [] }
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue
    const entry = statusEntry(fields, i)
    observed.entries.push(entry)
    if (entry.originalPath !== undefined) i++
    if (entry.status === '??') observed.changes.untracked++
    else if (entry.status === '!!') {
      observed.changes.ignored++
      observed.ignored.push(entry.path)
    } else observed.changes.tracked++
  }
  return observed
}
function identity(path: string): { dev: string; ino: string } {
  const s = lstatSync(path, { bigint: true })
  if (!s.isDirectory() || s.isSymbolicLink() || canonical(path) !== path)
    throw new Error('path is missing, inaccessible, or has a symlink component')
  return { dev: String(s.dev), ino: String(s.ino) }
}
// Binding the ignored-entry manifest stales a safe selection when an artifact root or protected entry appears or
// vanishes; content changes inside a listed root are covered by its whole-subtree approval. A force token carries its
// mode as a prefix and also binds the exact status output (renames included), the index stages, object IDs and flags,
// and the whole-tree metadata fingerprint, so any observed change after inventory stales the force selection.
function token(row: Row, id: unknown, evidence?: Evidence): string {
  const facts = {
    commonDir: row.commonDir,
    path: row.path,
    branch: row.branch,
    head: row.head,
    kind: row.kind,
    id,
    ignoredEntries: row.ignoredEntries,
  }
  if (row.removalMode === 'safe') return sha256(JSON.stringify(facts))
  return `force-${sha256(JSON.stringify({ ...facts, removalMode: row.removalMode, evidence: evidence ?? null }))}`
}
function headRetained(repo: string, head: string | null): boolean {
  if (!head) throw new Error('worktree HEAD is missing')
  return (
    git(repo, 'for-each-ref', '--count=1', `--contains=${head}`, '--format=%(refname)', 'refs/heads/', 'refs/tags/')
      .length > 0
  )
}
function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw e
  }
}
function inspectIndex(row: Row): { stage: string; flags: string } {
  const flags = git(row.path, 'ls-files', '-v', '-z')
  for (const entry of flags.split('\0')) {
    if (!entry) continue
    const tag = entry[0]
    if (/[a-z]/.test(tag) || (tag === 'S' && pathExists(join(row.path, entry.slice(2))))) {
      row.reasons.push('index contains assume-unchanged or present skip-worktree files')
      break
    }
  }
  const stage = git(row.path, 'ls-files', '--stage', '-z')
  for (const entry of stage.split('\0')) {
    if (!entry.startsWith('160000 ')) continue
    const tab = entry.indexOf('\t')
    if (tab < 0) throw new Error('malformed gitlink index entry')
    if (pathExists(join(row.path, entry.slice(tab + 1), '.git'))) {
      row.reasons.push('initialized submodule')
      break
    }
  }
  return { stage, flags }
}
function inspectOperations(row: Row) {
  for (const name of [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'BISECT_LOG',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'index.lock',
    'HEAD.lock',
  ]) {
    const path = git(row.path, 'rev-parse', '--path-format=absolute', '--git-path', name).replace(/\n$/, '')
    if (pathExists(path)) row.reasons.push(`git operation in progress: ${name}`)
  }
}
function inspectLocalData(row: Row): string {
  const observed = status(row.path)
  row.localChanges = observed.changes
  row.ignoredEntries = classifyIgnored(observed.ignored)
  if (row.removalMode === 'force') {
    // Force inspection keeps these data off the preservation reasons: one discard acknowledgment covers every record,
    // ignored ones included, so the artifact acknowledgment is not also required for the same data.
    row.localEntries = observed.entries
    row.requiresDiscardConfirmation = observed.entries.length > 0
    return observed.raw
  }
  row.requiresArtifactConfirmation = row.ignoredEntries.some((entry) => entry.kind !== 'protected')
  if (observed.changes.tracked) row.reasons.push('changes to tracked files')
  if (observed.changes.untracked) row.reasons.push('untracked files that Git does not ignore')
  const kept = row.ignoredEntries.filter((entry) => entry.kind === 'protected').length
  if (kept) row.reasons.push(`unrecognized or sensitive ignored data: ${kept} path(s)`)
  return observed.raw
}
// A force row also needs its HEAD retained by a local branch or tag: force discards local data, never commits.
function inspectRegistered(row: Row, record: Record<string, string>, repo: string): Inspection {
  const id = identity(row.path)
  let local: { status: string; stage: string; flags: string } | null = null
  if (record.bare === undefined) {
    const raw = inspectLocalData(row)
    local = { status: raw, ...inspectIndex(row) }
    inspectOperations(row)
  }
  applyUsage(row)
  const detached = record.detached !== undefined
  if ((detached || row.removalMode === 'force') && !headRetained(repo, row.head))
    row.reasons.push(`${detached ? 'detached ' : ''}HEAD is not reachable from a local branch or tag`)
  // Only an otherwise removable row pays for a metadata walk; a kept row is already preserved.
  if (row.reasons.length) return { id }
  if (row.removalMode === 'force' && local) {
    // Git's raw path bytes are decoded as UTF-8 with U+FFFD replacement; an ambiguous reported path keeps the row
    // before any walk or digest, so consent and staleness never rest on a lossy name.
    if ([row.path, local.status, local.stage, local.flags].some((text) => text.includes('\uFFFD'))) {
      row.reasons.push('Git reports a path that is not representable as UTF-8')
      return { id }
    }
    const tree = inspectForceTree(row)
    return {
      id,
      evidence: { status: sha256(local.status), stage: sha256(local.stage), flags: sha256(local.flags), tree },
    }
  }
  if (row.requiresArtifactConfirmation) inspectArtifactTrees(row)
  return { id }
}

export type { Inspection }
export { applyUsage, identity, inspectRegistered, token }
