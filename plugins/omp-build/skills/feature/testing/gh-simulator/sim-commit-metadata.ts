import type { Context } from './sim-command-context.ts'
import { git } from './sim-git.ts'
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
