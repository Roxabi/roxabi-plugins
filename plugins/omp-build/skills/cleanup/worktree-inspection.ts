import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { type Changes, canonical, git, inside, message, type Row } from './worktree-shared'

type Activity = 'idle' | 'active' | 'unknown'
type Usage = { activity: Activity; evidence: string[]; warnings: string[] }
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
function status(path: string): Changes {
  const entries = git(path, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching').split('\0')
  const counts = { tracked: 0, untracked: 0, ignored: 0 }
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    if (code === '??') counts.untracked++
    else if (code === '!!') counts.ignored++
    else {
      counts.tracked++
      if (code.includes('R') || code.includes('C')) i++
    }
  }
  return counts
}
function identity(path: string): { dev: string; ino: string } {
  const s = lstatSync(path, { bigint: true })
  if (!s.isDirectory() || s.isSymbolicLink() || canonical(path) !== path)
    throw new Error('path is missing, inaccessible, or has a symlink component')
  return { dev: String(s.dev), ino: String(s.ino) }
}
function token(row: Row, id: unknown): string {
  const facts = { commonDir: row.commonDir, path: row.path, branch: row.branch, head: row.head, kind: row.kind, id }
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex')
}
function detachedReachable(repo: string, head: string | null): boolean {
  if (!head) throw new Error('detached HEAD is missing')
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
function inspectIndex(row: Row) {
  const flags = git(row.path, 'ls-files', '-v', '-z').split('\0')
  for (const entry of flags) {
    if (!entry) continue
    const tag = entry[0]
    if (/[a-z]/.test(tag) || (tag === 'S' && pathExists(join(row.path, entry.slice(2))))) {
      row.reasons.push('index contains assume-unchanged or present skip-worktree files')
      break
    }
  }
  const entries = git(row.path, 'ls-files', '--stage', '-z').split('\0')
  for (const entry of entries) {
    if (!entry.startsWith('160000 ')) continue
    const tab = entry.indexOf('\t')
    if (tab < 0) throw new Error('malformed gitlink index entry')
    if (pathExists(join(row.path, entry.slice(tab + 1), '.git'))) {
      row.reasons.push('initialized submodule')
      break
    }
  }
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
function inspectRegistered(row: Row, record: Record<string, string>, repo: string): unknown {
  const id = identity(row.path)
  if (record.bare === undefined) {
    row.localChanges = status(row.path)
    if (Object.values(row.localChanges).some((n) => n > 0)) row.reasons.push('local tracked, untracked or ignored data')
    inspectIndex(row)
    inspectOperations(row)
  }
  applyUsage(row)
  if (record.detached !== undefined && !detachedReachable(repo, row.head))
    row.reasons.push('detached HEAD is not reachable from a local branch or tag')
  return id
}

export { applyUsage, identity, inspectRegistered, token }
