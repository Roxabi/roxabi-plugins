import { nativeNumber, nativePage, nativeReference } from './native-implementation-transport-graph.ts'
import type { NativeWorldFacts } from './native-implementation-world.ts'

type Pull = NativeWorldFacts['pullRequests'][number]
type Commit = NativeWorldFacts['commits'][number]
type Comparison = NativeWorldFacts['comparisons'][number]

function branchPullResponse(args: readonly string[], repository: string, pulls: Map<string, Pull>): string | undefined {
  const [owner, name] = repository.split('/')
  if (args.length !== 2 || args[0] !== 'api' || !args[1]?.startsWith(`repos/${owner}/${name}/pulls?`)) return undefined
  const url = new URL(args[1], 'https://fixture.invalid/')
  const params = url.searchParams
  const head = params.get('head')
  const pageText = params.get('page')
  if (
    [...params.keys()].sort().join(',') !== 'head,page,per_page,state' ||
    params.get('state') !== 'all' ||
    params.get('per_page') !== '100' ||
    head === null ||
    !head.startsWith(`${owner}:`) ||
    head.length === owner.length + 1 ||
    pageText === null ||
    !/^[1-9]\d*$/.test(pageText) ||
    !Number.isSafeInteger(Number(pageText))
  )
    throw new Error('Undeclared branch pull request enumeration')
  const branch = head.slice(owner.length + 1)
  const matching = [...pulls.values()].filter((pull) => pull.scope.repository === repository && pull.branch === branch)
  const offset = (Number(pageText) - 1) * 100
  return JSON.stringify(
    matching.slice(offset, offset + 100).map((pull) => {
      if (pull.state === 'MERGED' && (typeof pull.mergedAt !== 'string' || !Number.isFinite(Date.parse(pull.mergedAt))))
        throw new Error('Merged pull request timestamp is not declared')
      return {
        number: nativeNumber(pull.scope),
        state: pull.state === 'OPEN' ? 'open' : 'closed',
        merged_at: pull.state === 'MERGED' ? pull.mergedAt : null,
      }
    }),
  )
}

export function nativePullResponse(
  args: readonly string[],
  repository: string,
  pulls: Map<string, Pull>,
): string | undefined {
  const [owner, name] = repository.split('/')
  const branch = branchPullResponse(args, repository, pulls)
  if (branch !== undefined) return branch
  if (
    args.length === 12 &&
    args[0] === 'pr' &&
    args[1] === 'list' &&
    args[2] === '--head' &&
    args[4] === '--base' &&
    args[6] === '--state' &&
    args[7] === 'all' &&
    args[8] === '--limit' &&
    args[9] === '30' &&
    args[10] === '--json' &&
    args[11] === 'number,isCrossRepository,state'
  )
    return JSON.stringify(
      [...pulls.values()]
        .filter((pull) => pull.branch === args[3] && pull.base === args[5])
        .map((pull) => ({ number: nativeNumber(pull.scope), isCrossRepository: false, state: pull.state })),
    )
  const pullsQuery =
    'query=query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED]){pageInfo{hasNextPage endCursor}nodes{number headRefName baseRefName repository{nameWithOwner}}}}}'
  if (
    args.length === 8 &&
    args[0] === 'api' &&
    args[1] === 'graphql' &&
    args[2] === '-f' &&
    args[3] === pullsQuery &&
    args[4] === '-f' &&
    args[5] === `owner=${owner}` &&
    args[6] === '-f' &&
    args[7] === `name=${name}`
  )
    return JSON.stringify({
      data: {
        repository: {
          pullRequests: nativePage(
            [...pulls.values()].map((pull) => ({
              ...nativeReference(pull.scope),
              headRefName: pull.branch,
              baseRefName: pull.base,
            })),
          ),
        },
      },
    })
  if (args[0] === 'pr' && args[1] === 'view') {
    const target = `${args[4]}#${args[2]}`
    const pull = pulls.get(target)
    if (!pull || pull.scope.repository !== repository) throw new Error(`Undeclared PR ${target}`)
    return JSON.stringify({
      number: nativeNumber(pull.scope),
      state: pull.state,
      headRefOid: pull.head,
      headRefName: pull.branch,
      baseRefName: pull.base,
      baseRefOid: pull.baseTip,
      mergeCommit: pull.mergeCommit === null ? null : { oid: pull.mergeCommit },
      author: pull.author === null ? null : { login: pull.author },
    })
  }
  return undefined
}

export function nativeCommitResponse(
  args: readonly string[],
  repository: string,
  commits: Map<string, Commit>,
  comparisons: Map<string, Comparison>,
): string | undefined {
  const commitMatch = /^repos\/([^/]+\/[^/]+)\/git\/commits\/([a-f0-9]{40})$/.exec(args[1] ?? '')
  if (args[0] === 'api' && commitMatch) {
    const sha = commitMatch[2]
    const commit = commitMatch[1] === repository && sha !== undefined ? commits.get(sha) : undefined
    if (!commit) throw new Error(`Undeclared commit ${commitMatch[2]}`)
    return JSON.stringify({ sha: commit.sha, parents: commit.parents.map((sha) => ({ sha })) })
  }
  const range = /^repos\/([^/]+\/[^/]+)\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=100&page=(\d+)$/.exec(
    args[1] ?? '',
  )
  if (args[0] === 'api' && range) {
    const comparison = range[1] === repository ? comparisons.get(`${range[2]}\0${range[3]}`) : undefined
    if (!comparison) throw new Error(`Undeclared comparison ${range[2]}...${range[3]}`)
    const entries = comparison.commits.slice((Number(range[4]) - 1) * 100, Number(range[4]) * 100).map((sha) => {
      const commit = commits.get(sha)
      if (!commit) throw new Error(`Undeclared commit ${sha}`)
      return { sha, parents: commit.parents.map((parent) => ({ sha: parent })) }
    })
    return JSON.stringify({ status: comparison.status, total_commits: comparison.commits.length, commits: entries })
  }
  return undefined
}
