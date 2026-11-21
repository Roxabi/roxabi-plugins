import type { Gh } from '../adapters/github/types.ts'
import { handle } from '../skills/feature/testing/gh-simulator/sim-command.ts'
import { runInvocation } from '../skills/feature/testing/gh-simulator/sim-invocation.ts'
import { base, pull } from '../skills/feature/testing/gh-simulator/sim-transport-fixture.ts'
import type { State } from '../skills/feature/testing/gh-simulator/sim-types.ts'
import { fixtureCatalogueGhResponse } from './action-input-fixtures.ts'
import { createNativeComments } from './native-implementation-transport-comments.ts'
import { type NativeEpicFacts, nativeEpicResponse } from './native-implementation-transport-epic.ts'
import { nativeGraphResponse } from './native-implementation-transport-graph.ts'
import { nativeCommitResponse, nativePullResponse } from './native-implementation-transport-pulls.ts'
import type { NativeWorldFacts } from './native-implementation-world.ts'

type NativeTransportInput = {
  repository: string
  originUrl?: string
  epic?: NativeEpicFacts
  author: string
  histories: NativeWorldFacts['histories']
  authorization?: NativeWorldFacts['authorization']
  graph: NativeWorldFacts['graph']
  commits: Map<string, NativeWorldFacts['commits'][number]>
  pulls: Map<string, NativeWorldFacts['pullRequests'][number]>
  comparisons: Map<string, NativeWorldFacts['comparisons'][number]>
}

function authorizationState(input: NativeTransportInput): State | null {
  const { repository, pulls } = input
  const auth = input.authorization
  if (!auth) return null
  const [owner, name] = repository.split('/')
  const state = base({
    owner,
    name,
    viewer: input.author,
    viewerId: auth.operatorId,
    repositoryId: auth.repositoryId,
    authorizationVariables: {
      HEAD_AUTH_REPOSITORY_ID: String(auth.repositoryId),
      HEAD_AUTH_OPERATOR_IDS: JSON.stringify([auth.operatorId]),
      HEAD_AUTH_APP_ID: String(auth.appId),
      HEAD_AUTH_BOT_USER_ID: String(auth.botUserId),
    },
    remoteRefs: {},
  }) as State
  let commentId = 1
  for (const history of input.histories) {
    const facts = pulls.get(history.source.scope.target)
    const rows = history.source.comments.map((comment) => ({
      id: commentId++,
      author: comment.author ?? '',
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    }))
    if (!facts?.gate) continue
    if (
      history.source.scope.repository !== repository ||
      rows.some(
        (row) =>
          !row.author ||
          !row.createdAt ||
          !row.updatedAt ||
          row.body.startsWith('<!-- kit-head-authorization:v1 -->\n'),
      )
    )
      throw new Error('Authorization fixture history is incomplete')
    const number = Number(facts.scope.target.slice(facts.scope.target.lastIndexOf('#') + 1))
    if (!Number.isSafeInteger(number) || number <= 0 || facts.author !== input.author)
      throw new Error('Authorization fixture pull request identity is incomplete')
    const existing = state.remoteRefs?.[facts.base]
    if (existing !== undefined && existing !== facts.baseTip) throw new Error('Conflicting declared base tips')
    if (state.remoteRefs) state.remoteRefs[facts.base] = facts.baseTip
    state.prs[String(number)] = pull(number, facts.branch, facts.head, {
      baseRefName: facts.base,
      baseRefOid: facts.baseTip,
      state: facts.state,
      labels: [...facts.gate.labels],
      autoMerge: facts.gate.autoMerge,
      comments: rows,
    }) as State['prs'][string]
  }
  state.nextCommentId = commentId
  return state
}

function isAuthorizationApiRequest(root: string, endpoint: string, args: string[]): boolean {
  if (args[0] !== 'api') return false
  return (
    (args[1] === 'user' && args.length === 2) ||
    (args[1] === 'graphql' && args.some((arg) => arg.includes('IssueComment') && arg.includes('lastEditedAt'))) ||
    args[1] === root ||
    endpoint.startsWith(`${root}/actions/variables?`) ||
    endpoint.startsWith(`${root}/pulls/`) ||
    endpoint.startsWith(`${root}/git/ref/heads/`)
  )
}

function isAuthorizationRequest(state: State, repository: string, args: string[]): boolean {
  const root = `repos/${repository}`
  const endpoint = args.find((arg) => arg.startsWith(`${root}/`)) ?? ''
  const match = new RegExp(`^${root}/issues/(\\d+)/comments(?:\\?|$)`).exec(endpoint)
  const pr =
    args[0] === 'pr' && (args[1] === 'view' || args[1] === 'merge' || args[1] === 'edit')
      ? state.prs[args[2] ?? '']
      : undefined
  const gateView = args[1] !== 'view' || args.includes('headRefOid,state,labels,autoMergeRequest,mergeStateStatus')
  return (
    (pr !== undefined && gateView) ||
    (match !== null && state.prs[match[1] ?? ''] !== undefined) ||
    isAuthorizationApiRequest(root, endpoint, args)
  )
}

export function createNativeImplementationTransport(input: NativeTransportInput) {
  const { repository, commits, pulls, comparisons } = input
  const comments = createNativeComments(repository, input.author, input.histories)
  const state = authorizationState(input)
  function authorizationResponse(cwd: string, args: string[]): string | undefined {
    if (!state || !isAuthorizationRequest(state, repository, args)) return undefined
    return runInvocation(
      {
        cwd,
        readStdin: () => {
          throw new Error('Undeclared simulator stdin')
        },
      },
      (invocation) => {
        handle(state, args)
        return invocation.stdout.trim()
      },
    )
  }
  function pullIssueResponse(args: readonly string[]): string | undefined {
    if (args.length !== 2 || args[0] !== 'api' || !state) return undefined
    const match = new RegExp(`^repos/${repository}/issues/([1-9][0-9]*)$`).exec(args[1] ?? '')
    if (match === null) return undefined
    const pr = state.prs[match[1] ?? '']
    if (pr === undefined) return undefined
    return JSON.stringify({
      number: pr.number,
      state: pr.state === 'OPEN' ? 'open' : 'closed',
      body: pr.body,
      user: null,
      pull_request: {},
    })
  }
  let graph = input.graph
  function repositoryResponse(args: readonly string[]): string {
    const reference = args[2]
    if (
      reference !== undefined &&
      !reference.startsWith('-') &&
      reference !== repository &&
      reference !== input.originUrl
    )
      throw new Error(`Undeclared repository reference ${reference}`)
    const jq = args.indexOf('--jq')
    if (jq === -1) return JSON.stringify({ nameWithOwner: repository })
    if (args[jq + 1] !== '.nameWithOwner') throw new Error('Undeclared repository projection')
    return repository
  }
  function identityResponse(args: readonly string[]): string | undefined {
    if (args[0] === 'api' && args[1] === 'user') return input.author
    if (args[0] === 'repo' && args[1] === 'view') return repositoryResponse(args)
    return undefined
  }
  const ghSync = (cwd: string, args: string[]): string => {
    const responders = [
      () => authorizationResponse(cwd, args),
      () => fixtureCatalogueGhResponse(args) ?? undefined,
      () => identityResponse(args),
      () => pullIssueResponse(args),
      () => nativeEpicResponse(args, repository, graph, pulls, commits, input.epic),
      () => nativeGraphResponse(args, repository, graph),
      () => comments.response(args),
      () => nativePullResponse(args, repository, pulls),
      () => nativeCommitResponse(args, repository, commits, comparisons),
    ]
    for (const respond of responders) {
      const response = respond()
      if (response !== undefined) return response
    }
    throw new Error(`Undeclared GitHub request ${args.join(' ')}`)
  }
  const gh: Gh = async (cwd, args) => ghSync(cwd, args)
  function observeGraph(next: NativeWorldFacts['graph']): void {
    if (
      next.root.repository !== repository ||
      next.nodes.some((node) => node.uw.repository !== repository || !comments.has(node.uw))
    )
      throw new Error('Graph observation refers to an undeclared native scope')
    graph = next
  }
  function observePullRequest(facts: NativeWorldFacts['pullRequests'][number]): void {
    if (
      facts.scope.repository !== repository ||
      !comments.has(facts.scope) ||
      !commits.has(facts.head) ||
      !commits.has(facts.baseTip) ||
      (facts.mergeCommit !== null && !commits.has(facts.mergeCommit))
    )
      throw new Error('Pull request observation has undeclared history or commits')
    const number = facts.scope.target.slice(facts.scope.target.lastIndexOf('#') + 1)
    const simulated = state?.prs[number]
    if (simulated) {
      simulated.headRefOid = facts.head
      simulated.baseRefOid = facts.baseTip
      simulated.state = facts.state
      if (state?.remoteRefs) state.remoteRefs[facts.base] = facts.baseTip
    }
    pulls.set(facts.scope.target, facts)
  }
  return { gh, ghSync, observeGraph, observePullRequest, editComment: comments.editComment }
}
