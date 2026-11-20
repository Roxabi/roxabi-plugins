import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Context } from './sim-command-context.ts'
import { git } from './sim-git.ts'
import { emit, one } from './sim-graphql.ts'
import { statePath } from './sim-state.ts'
import { fail } from './sim-types.ts'

type ObservedCommit = { sha: string; parents: { sha: string }[]; tree: { sha: string } }

// GitHub answers SHA-addressed history from the objects alone: it ignores replace refs, and its
// repositories are neither grafted nor shallow. These reads therefore pass --no-replace-objects, and
// with no grafts or shallow boundary each answer is fixed by the commit SHAs. Remembering successful
// answers on disk spares one git process per repeated read inside the simulator's state lock.
function memoFile(context: Context, key: readonly string[]): string | null {
  const origin = context.state.origin
  if (existsSync(join(origin, 'shallow')) || existsSync(join(origin, 'info', 'grafts'))) return null
  const digest = createHash('sha256')
    .update([origin, ...key].join('\0'))
    .digest('hex')
  return join(`${statePath()}.git-memo`, digest)
}

function recall(file: string | null): string | null {
  if (file === null) return null
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function remember(file: string | null, value: string): void {
  if (file === null) return
  mkdirSync(join(file, '..'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, value)
  renameSync(tmp, file)
}

function immutableGit(context: Context, args: string[]): string {
  const file = memoFile(context, args)
  const known = recall(file)
  if (known !== null) return known
  const output = git(context.state.origin, ['--no-replace-objects', ...args])
  remember(file, output)
  return output
}

function parseCommit(line: string): ObservedCommit {
  const fields = line.split('\0')
  const [sha, tree, parentList] = fields
  if (
    fields.length !== 3 ||
    !sha ||
    !tree ||
    parentList === undefined ||
    !/^[a-f0-9]{40}$/.test(sha) ||
    !/^[a-f0-9]{40}$/.test(tree)
  )
    fail('gh: commit metadata is unreadable')
  const parents = parentList === '' ? [] : parentList.split(' ')
  if (parents.some((parent) => !/^[a-f0-9]{40}$/.test(parent))) fail('gh: commit metadata is unreadable')
  return { sha, parents: parents.map((parent) => ({ sha: parent })), tree: { sha: tree } }
}

export function observedCommits(context: Context, shas: readonly string[]): Map<string, ObservedCommit> {
  const requested = [...new Set(shas)]
  const records = new Map<string, ObservedCommit>()
  const missing: string[] = []
  for (const sha of requested) {
    const line = recall(memoFile(context, ['commit', sha]))
    if (line === null) missing.push(sha)
    else records.set(sha, parseCommit(line))
  }
  if (missing.length > 0) {
    const fetched = new Map<string, string>()
    const output = git(context.state.origin, [
      '--no-replace-objects',
      'log',
      '--no-walk=unsorted',
      '--format=%H%x00%T%x00%P',
      ...missing,
    ])
    for (const line of output.split('\n')) {
      const record = parseCommit(line)
      if (records.has(record.sha)) fail('gh: commit metadata is unreadable')
      records.set(record.sha, record)
      fetched.set(record.sha, line)
    }
    for (const [sha, line] of fetched) remember(memoFile(context, ['commit', sha]), line)
  }
  for (const sha of requested) if (!records.has(sha)) fail(`gh: commit ${sha} not found`)
  return records
}

export function observedCommit(context: Context, sha: string): ObservedCommit {
  const result = observedCommits(context, [sha]).get(sha)
  if (!result) fail(`gh: commit ${sha} not found`)
  return result
}

function emitDeliveryComparison(context: Context, compare: RegExpExecArray): void {
  const base = compare[3]
  const head = compare[4]
  if (base === undefined || head === undefined) fail('gh: invalid comparison')
  // Both endpoints are full SHAs, so each range has one answer; metadata is batched once its page is known.
  const ahead = immutableGit(context, ['rev-list', '--reverse', `${base}..${head}`])
    .split('\n')
    .filter(Boolean)
  const behind = immutableGit(context, ['rev-list', '--count', `${head}..${base}`])
  const status = ahead.length === 0 ? (behind === '0' ? 'identical' : 'behind') : behind === '0' ? 'ahead' : 'diverged'
  const page = Number(compare[5])
  if (!Number.isSafeInteger(page)) fail('gh: invalid comparison page')
  const pageShas = ahead.slice((page - 1) * 100, page * 100)
  const metadata = observedCommits(context, [base, head, ...pageShas])
  const commits = pageShas.map((sha) => {
    const commit = metadata.get(sha)
    if (!commit) fail(`gh: commit ${sha} not found`)
    return commit
  })
  emit(
    {
      status,
      total_commits: ahead.length,
      commits,
    },
    context.expression,
  )
}

export function apiDeliveryGit(context: Context): boolean {
  const path = context.sub ?? ''
  const commit = /^repos\/([^/]+)\/([^/]+)\/git\/commits\/([a-f0-9]{40})$/.exec(path)
  const compare =
    /^repos\/([^/]+)\/([^/]+)\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=100&page=([1-9][0-9]*)$/.exec(path)
  const match = commit ?? compare
  if (!match || one(context.flag, '--method') !== undefined) return false
  if (match[1] !== context.state.owner || match[2] !== context.state.name) fail('gh: repository not found')
  if (commit) {
    const sha = commit[3]
    if (sha === undefined) fail('gh: invalid commit')
    emit(observedCommit(context, sha), context.expression)
    return true
  }
  if (!compare) return false
  emitDeliveryComparison(context, compare)
  return true
}
