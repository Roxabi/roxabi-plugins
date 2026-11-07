import type { Context } from './sim-command-context.ts'
import { git } from './sim-git.ts'
import { emit, one } from './sim-graphql.ts'
import { fail } from './sim-types.ts'

type ObservedCommit = { sha: string; parents: { sha: string }[]; tree: { sha: string } }

export function observedCommits(context: Context, shas: readonly string[]): Map<string, ObservedCommit> {
  const requested = [...new Set(shas)]
  const output = git(context.state.origin, ['log', '--no-walk=unsorted', '--format=%H%x00%T%x00%P', ...requested])
  const records = new Map<string, ObservedCommit>()
  for (const line of output.split('\n')) {
    const fields = line.split('\0')
    const [sha, tree, parentList] = fields
    if (
      fields.length !== 3 ||
      !sha ||
      !tree ||
      parentList === undefined ||
      !/^[a-f0-9]{40}$/.test(sha) ||
      !/^[a-f0-9]{40}$/.test(tree) ||
      records.has(sha)
    )
      fail('gh: commit metadata is unreadable')
    const parents = parentList === '' ? [] : parentList.split(' ')
    if (parents.some((parent) => !/^[a-f0-9]{40}$/.test(parent))) fail('gh: commit metadata is unreadable')
    records.set(sha, { sha, parents: parents.map((parent) => ({ sha: parent })), tree: { sha: tree } })
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
  // Range observations stay fresh for this request; metadata is batched only after its page is known.
  const ahead = git(context.state.origin, ['rev-list', '--reverse', `${base}..${head}`])
    .split('\n')
    .filter(Boolean)
  const behind = git(context.state.origin, ['rev-list', '--count', `${head}..${base}`])
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
