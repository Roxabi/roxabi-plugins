import { nativeComment } from '../../adapters/__tests__/github-workflow-support.ts'
import { looseHeaderClue } from '../../adapters/github/history-authority.ts'
import { type Gh, parseComment } from '../../adapters/github/types.ts'
import { nativeGitHub } from '../../testing/framing-native-github.ts'

type Pull = {
  number: number
  branch: string
  base: string
  head: string
  baseTip: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergeCommit: string | null
}

type CommentHooks = { rejectControl: boolean; afterComment: (kind: string | null, number: number) => void }

/** Stateful native PRs and comment transport faults; no workflow internals are replaced. */
export function successorGitHub(issues: Parameters<typeof nativeGitHub>[0]) {
  const native = nativeGitHub(issues)
  const pulls = new Map<number, Pull>()
  const hooks = {
    rejectControl: false,
    afterComment: (_kind: string | null, _number: number) => {},
  }
  const addPull = (number: number, overrides: Partial<Omit<Pull, 'number'>> = {}) => {
    const pull: Pull = {
      number,
      branch: 'feature/bounded',
      base: 'main',
      head: 'a'.repeat(40),
      baseTip: 'b'.repeat(40),
      state: 'OPEN',
      mergeCommit: null,
      ...overrides,
    }
    pulls.set(number, pull)
    native.issues.set(number, { title: 'Existing delivery', body: '', labels: [], parent: null, blockers: [] })
    if (!native.comments.has(number)) native.comments.set(number, [])
    return pull
  }
  const gh: Gh = async (cwd, args) => {
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    if (args[0] === 'pr' && args[1] === 'list') return listPulls(pulls, args)
    if (args[0] === 'pr' && args[1] === 'view') return readPull(pulls, args)
    if (args[0] === 'api' && args[1] === 'graphql' && field(args, 'query')?.includes('pullRequests(first:100')) {
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: [...pulls.values()].map((pull) => ({
                number: pull.number,
                headRefName: pull.branch,
                baseRefName: pull.base,
                repository: { nameWithOwner: 'acme/app' },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
    }
    return restRequest(native, pulls, hooks, cwd, args)
  }
  return { native, gh, pulls, addPull, hooks }
}

function field(args: string[], name: string): string | undefined {
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1)
}

function listPulls(pulls: ReadonlyMap<number, Pull>, args: string[]): string {
  const head = args[args.indexOf('--head') + 1]
  const base = args[args.indexOf('--base') + 1]
  return JSON.stringify(
    [...pulls.values()]
      .filter((pull) => pull.branch === head && pull.base === base)
      .map((pull) => ({ number: pull.number, isCrossRepository: false, state: pull.state })),
  )
}

function readPull(pulls: ReadonlyMap<number, Pull>, args: string[]): string {
  const pull = pulls.get(Number(args[2]))
  if (!pull) throw new Error(`Unknown fixture PR ${args[2]}`)
  return JSON.stringify({
    number: pull.number,
    state: pull.state,
    headRefOid: pull.head,
    headRefName: pull.branch,
    baseRefName: pull.base,
    baseRefOid: pull.baseTip,
    mergeCommit: pull.mergeCommit === null ? null : { oid: pull.mergeCommit },
    author: { login: 'automation' },
  })
}

async function restRequest(
  native: ReturnType<typeof nativeGitHub>,
  pulls: ReadonlyMap<number, Pull>,
  hooks: CommentHooks,
  cwd: string,
  args: string[],
): Promise<string> {
  const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
  const commit = /^repos\/acme\/app\/git\/commits\/([0-9a-f]{40})$/.exec(endpoint)
  if (commit?.[1] === 'd'.repeat(40))
    return JSON.stringify({ sha: commit[1], parents: ['a'.repeat(40), 'b'.repeat(40)].map((sha) => ({ sha })) })
  const issue = /^repos\/acme\/app\/issues\/(\d+)$/.exec(endpoint)
  if (issue && pulls.has(Number(issue[1])) && !args.includes('PATCH')) {
    return JSON.stringify({
      number: Number(issue[1]),
      title: 'Existing delivery',
      body: '',
      state: 'open',
      user: { login: 'automation' },
      pull_request: { url: `https://api.github.test/pulls/${issue[1]}` },
    })
  }
  const comment = /^repos\/acme\/app\/issues\/(\d+)\/comments(?:\?.*)?$/.exec(endpoint)
  const body = field(args, 'body')
  if (comment && args.includes('POST') && body !== undefined) {
    const scope = { repository: 'acme/app', target: `acme/app#${comment[1]}` }
    const kind = looseHeaderClue(parseComment(nativeComment(999999, body), scope, 0, 0)).kind
    if (hooks.rejectControl && kind === 'operator-control') throw new Error('fixture control publication rejected')
    const response = await native.gh(cwd, args)
    hooks.afterComment(kind, Number(comment[1]))
    return response
  }
  return native.gh(cwd, args)
}
