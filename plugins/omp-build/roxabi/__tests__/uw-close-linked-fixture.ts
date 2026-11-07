import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { Gh } from '../../adapters/github/types.ts'
import { UW_GRAPH_QUERY } from '../../adapters/github-native/uw-graph-query.ts'
import { deliveredLeaf } from '../../engine/__tests__/uw-delivery-proof-fixture.ts'
import { scopeKey } from '../../engine/uw-graph.ts'
import { createOperatorConfirmation } from '../../omp/omp-operator-confirmation.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'

// The transport is a declared GitHub world, not a completion or writer substitute.
export async function closeLinkedWorld(
  options: {
    closed?: boolean
    nativeState?: { state: 'OPEN' | 'CLOSED'; stateReason: string | null }
    confirmReopen?: boolean
    race?: 'native-before-write' | 'proof-after-write' | 'unreadable-after-write' | 'lost-effect'
  } = {},
) {
  const leaf = await deliveredLeaf()
  const node = leaf.observation.graph.nodes.find((entry) => entry.uw.target === leaf.uw.target)
  if (!node) throw new Error('Declared UW missing')
  const comments = new Map(
    leaf.observation.histories.map((history) => [
      history.source.scope.target,
      history.source.comments.map((comment, index) => {
        if (!comment.author || !comment.createdAt || !comment.updatedAt)
          throw new Error('Missing native comment metadata')
        return {
          id: index + 1,
          body: comment.body,
          user: { login: comment.author },
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        }
      }),
    ]),
  )
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
  const ref = (number: number) => ({ number, repository: { nameWithOwner: 'acme/app' } })
  const commits = new Map([
    [leaf.base, [] as string[]],
    [leaf.head, [leaf.base]],
    [leaf.merge, [leaf.base, leaf.head]],
  ])
  const comparisons = new Map([
    [`${leaf.base}\0${leaf.base}`, []],
    [`${leaf.head}\0${leaf.head}`, []],
    [`${leaf.merge}\0${leaf.merge}`, []],
    [`${leaf.base}\0${leaf.head}`, [leaf.head]],
    [`${leaf.base}\0${leaf.merge}`, [leaf.head, leaf.merge]],
    [`${leaf.head}\0${leaf.merge}`, [leaf.merge]],
  ])
  let state: { state: 'OPEN' | 'CLOSED'; stateReason: string | null } =
    options.nativeState ??
    (options.closed ? { state: 'CLOSED', stateReason: 'COMPLETED' } : { state: 'OPEN', stateReason: null })
  let graphReads = 0
  let effect = false
  let confirmations = 0
  const effects: string[] = []
  let pullHead = leaf.head
  const readGraphAndPulls = (args: string[]) => {
    if (
      args.length === 10 &&
      args[0] === 'api' &&
      args[1] === 'graphql' &&
      args[3] === `query=${UW_GRAPH_QUERY}` &&
      args[5] === 'owner=acme' &&
      args[7] === 'name=app' &&
      args[9] === 'number=42'
    ) {
      graphReads++
      if (effect && options.race === 'unreadable-after-write') throw new Error('Native readback unavailable')
      if (!effect && options.race === 'native-before-write' && graphReads >= 2)
        state = { state: 'CLOSED', stateReason: 'NOT_PLANNED' }
      return JSON.stringify({
        data: {
          repository: {
            issue: {
              ...ref(42),
              title: node.title,
              body: node.raw.body,
              updatedAt: node.updatedAt,
              ...state,
              parent: null,
              labels: page(node.labels.map((name) => ({ name }))),
              subIssues: page([]),
              blockedBy: page([]),
            },
          },
        },
      })
    }
    const pullsQuery =
      'query=query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,states:[OPEN,CLOSED,MERGED]){pageInfo{hasNextPage endCursor}nodes{number headRefName baseRefName repository{nameWithOwner}}}}}'
    if (
      args.length === 8 &&
      args[0] === 'api' &&
      args[1] === 'graphql' &&
      args[3] === pullsQuery &&
      args[5] === 'owner=acme' &&
      args[7] === 'name=app'
    )
      return JSON.stringify({
        data: {
          repository: { pullRequests: page([{ ...ref(142), headRefName: 'feat/42-save', baseRefName: 'main' }]) },
        },
      })
  }

  const writeIssueState = (args: string[]) => {
    if (
      args[0] === 'api' &&
      args[1] === '--method' &&
      args[2] === 'PATCH' &&
      args[3] === 'repos/acme/app/issues/42' &&
      args[4] === '--raw-field' &&
      args[5] === 'state=open' &&
      args[6] === '--raw-field' &&
      args[7] === 'state_reason=reopened' &&
      args.length === 8
    ) {
      effects.push('reopen')
      state = { state: 'OPEN', stateReason: 'REOPENED' }
      return '{}'
    }
    if (
      args[0] === 'api' &&
      args[1] === '--method' &&
      args[2] === 'PATCH' &&
      args[3] === 'repos/acme/app/issues/42' &&
      args[4] === '--raw-field' &&
      args[5] === 'state=closed' &&
      args[6] === '--raw-field' &&
      args[7] === 'state_reason=completed' &&
      args.length === 8
    ) {
      state = { state: 'CLOSED', stateReason: 'COMPLETED' }
      effects.push('close')
      effect = true
      if (options.race === 'proof-after-write') pullHead = leaf.base
      if (options.race === 'lost-effect') throw new Error('Close response lost')
      return '{}'
    }
  }

  const readCommentHistory = (args: string[]) => {
    const commentPath = /^repos\/acme\/app\/issues\/(42|142)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] ?? '')
    if (args[0] === 'api' && commentPath) {
      const list = comments.get(`acme/app#${commentPath[1]}`)
      if (!list) throw new Error('Undeclared history')
      const offset = (Number(commentPath[2]) - 1) * 100
      return JSON.stringify(list.slice(offset, offset + 100))
    }
  }

  const readCommit = (args: string[]) => {
    const commitPath = /^repos\/acme\/app\/git\/commits\/([a-f0-9]{40})$/.exec(args[1] ?? '')
    if (args[0] === 'api' && commitPath) {
      const sha = commitPath[1]
      if (!sha) throw new Error('Missing commit SHA')
      const parents = commits.get(sha)
      if (!parents) throw new Error('Undeclared commit')
      return JSON.stringify({ sha: commitPath[1], parents: parents.map((sha) => ({ sha })) })
    }
  }

  const readComparison = (args: string[]) => {
    const range = /^repos\/acme\/app\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})\?per_page=100&page=(\d+)$/.exec(
      args[1] ?? '',
    )
    if (args[0] === 'api' && range) {
      const entries = comparisons.get(`${range[1]}\0${range[2]}`)
      if (!entries) throw new Error(`Undeclared comparison ${range[1]}...${range[2]}`)
      const selected = entries.slice((Number(range[3]) - 1) * 100, Number(range[3]) * 100)
      return JSON.stringify({
        status: entries.length ? 'ahead' : 'identical',
        total_commits: entries.length,
        commits: selected.map((sha) => {
          const parents = commits.get(sha)
          if (!parents) throw new Error('Undeclared commit')
          return { sha, parents: parents.map((parent) => ({ sha: parent })) }
        }),
      })
    }
  }

  const readPullRequest = (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '142' && args[4] === 'acme/app')
      return JSON.stringify({
        number: 142,
        state: 'MERGED',
        headRefOid: pullHead,
        headRefName: 'feat/42-save',
        baseRefName: 'main',
        baseRefOid: leaf.base,
        mergeCommit: { oid: leaf.merge },
        author: { login: 'operator' },
      })
  }
  const routes = [readGraphAndPulls, readPullRequest, writeIssueState, readCommentHistory, readCommit, readComparison]

  const gh: Gh = async (_cwd, args) => {
    const catalogue = fixtureCatalogueGhResponse(args)
    if (catalogue !== null) return catalogue
    if (args[0] === 'api' && args[1] === 'user') return 'operator'
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: 'acme/app' })
    for (const route of routes) {
      const response = route(args)
      if (response !== undefined) return response
    }
    throw new Error(`Undeclared GitHub request ${args.join(' ')}`)
  }
  const artifacts = options.confirmReopen ? mkdtempSync(join(tmpdir(), 'omp-reopen-proof-')) : null
  const operator =
    artifacts !== null
      ? createOperatorConfirmation({
          agent: { kind: 'main', depth: 0 },
          hasUI: true,
          mode: 'tui',
          ui: {
            async confirm() {
              confirmations++
              return true
            },
          },
          localProtocolOptions: { getArtifactsDir: () => artifacts },
        } as unknown as ExtensionContext)
      : {
          async executeConfirmed() {
            throw new Error('Operator interaction is not authorized')
          },
        }
  const operations = await createInstalledUwOperations({ cwd: '/simulated', gh, readAuthor: 'operator', operator })
  const before = await operations.readUw(leaf.uw)
  const completion = before.completion.completions.get(scopeKey(leaf.uw))
  if (before.observation.status !== 'complete' || completion?.state !== 'complete')
    throw new Error(`Declared delivery not complete: ${JSON.stringify(before.completion.diagnostics)}`)
  graphReads = 0
  const request = {
    uw: leaf.uw,
    pullRequest: leaf.pullRequest,
    mandate: { scope: leaf.uw, kind: 'mandate' as const, recordId: leaf.mandate.recordId },
    completion,
  }
  const removeReview = () => {
    const history = leaf.review.history
    const operation = history.operations.find((entry) => entry.recordId === leaf.review.review.recordId)
    if (!operation) throw new Error('Declared review operation missing')
    const locators = new Set(operation.parts.map((part) => part.locator))
    const retained = history.source.comments.flatMap((comment, index) =>
      locators.has(comment.locator) ? [] : [index + 1],
    )
    const current = comments.get(leaf.pullRequest.target)
    if (!current) throw new Error('Declared PR history missing')
    comments.set(
      leaf.pullRequest.target,
      current.filter((comment) => retained.includes(comment.id)),
    )
  }
  return {
    leaf,
    gh,
    operations,
    request,
    state: () => state,
    confirmations: () => confirmations,
    effects,
    dispose: () => {
      if (artifacts !== null) rmSync(artifacts, { recursive: true, force: true })
    },
    changedHead: () => {
      pullHead = leaf.base
    },
    removeReview,
  }
}
