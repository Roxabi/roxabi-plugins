import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import core from '../../vendor/kit-head-authorization/index.cjs'
import { toolingGh } from './review-record-pin.js'

const TIME = '2026-01-01T00:03:00Z'

function authorizationTransport({ history, state, fixture, historyPage }) {
  const prefix = `repos/${fixture.repository}`
  const receiptRows = []
  const repositoryId = 1
  const prId = 1000 + fixture.pr
  const nextId = () =>
    Math.max(
      0,
      ...history.source.comments.map((comment) => Number(comment.nativeId)),
      ...receiptRows.map((row) => row.id),
    ) + 1
  const publish = (body) => {
    const id = nextId()
    const row = {
      id,
      node_id: `IC_${id}`,
      user: { id: 101, login: fixture.author, type: 'User' },
      performed_via_github_app: null,
      body,
      created_at: TIME,
      updated_at: TIME,
    }
    receiptRows.push(row)
    return row
  }
  if (fixture.initialAuthorization)
    publish(
      core.render({
        version: 1,
        kind: 'grant',
        operationId: 'fixture-initial',
        repositoryId,
        pullRequestId: prId,
        pullRequest: fixture.pr,
        headSha: state.head,
        baseRef: 'main',
        baseSha: fixture.heads[0],
        lane: 'reviewed',
        source: 'native',
        previous: null,
        evidence: 'fixture-review',
      }),
    )
  fixture.nextCommentId = nextId
  function variables(endpoint) {
    if (fixture.authorizationVariablesForbidden) throw new Error('HTTP 403')
    const rows = Object.entries(
      fixture.authorizationVariables ?? {
        HEAD_AUTH_REPOSITORY_ID: '1',
        HEAD_AUTH_OPERATOR_IDS: '[101]',
        HEAD_AUTH_APP_ID: '200',
        HEAD_AUTH_BOT_USER_ID: '201',
      },
    ).map(([name, value]) => ({ name, value }))
    const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1)
    const selected = rows.slice((page - 1) * 100, page * 100)
    const link =
      rows.length > page * 100
        ? `Link: <https://api.github.com/${prefix}/actions/variables?per_page=100&page=${page + 1}>; rel="next"\r\n`
        : ''
    return `HTTP/2 200\r\nContent-Type: application/json\r\n${link}\r\n${JSON.stringify({ total_count: rows.length, variables: selected })}`
  }
  function proof(args) {
    const id = String(args.find((arg) => String(arg).startsWith('id=')) ?? '').slice(3)
    const row = receiptRows.find((entry) => entry.node_id === id)
    return JSON.stringify({
      data: {
        node: row
          ? {
              id,
              fullDatabaseId: String(row.id),
              lastEditedAt: null,
              repository: { fullDatabaseId: String(repositoryId) },
              pullRequest: { number: fixture.pr, fullDatabaseId: String(prId) },
            }
          : null,
      },
    })
  }
  function comments(args, endpoint) {
    if (endpoint === `${prefix}/issues/${fixture.pr}/comments` && args.includes('POST')) {
      const body = String(args.find((arg) => String(arg).startsWith('body=')) ?? '').slice(5)
      if (body.startsWith(core.PREFIX)) return JSON.stringify(publish(body))
    }
    if (typeof endpoint !== 'string' || !endpoint.startsWith(`${prefix}/issues/${fixture.pr}/comments?`)) return null
    const page = Number(/[?&]page=(\d+)/.exec(endpoint)?.[1] ?? 1)
    const rows = [...JSON.parse(historyPage(history)), ...receiptRows].sort((a, b) => a.id - b.id)
    const selected = rows.slice((page - 1) * 100, page * 100)
    if (!args.includes('--include')) return JSON.stringify(selected)
    const link =
      rows.length > page * 100
        ? `Link: <https://api.github.com/${prefix}/issues/${fixture.pr}/comments?per_page=100&page=${page + 1}>; rel="next"\r\n`
        : ''
    return `HTTP/2 200\r\nContent-Type: application/json\r\n${link}\r\n${JSON.stringify(selected)}`
  }
  function scopeResponse(endpoint) {
    if (endpoint === `${prefix}/git/ref/heads/main`)
      return JSON.stringify({ ref: 'refs/heads/main', object: { sha: fixture.heads[0] } })
    if (endpoint === prefix) return JSON.stringify({ id: repositoryId })
    if (endpoint === `${prefix}/pulls/${fixture.pr}`)
      return JSON.stringify({
        id: prId,
        number: fixture.pr,
        user: { id: 101 },
        head: { sha: state.head },
        base: { ref: 'main', sha: fixture.heads[0], repo: { id: repositoryId } },
      })
    return null
  }

  function readMetadata(args, endpoint) {
    if (args[1] === 'user')
      return args.includes('--jq') || args.includes('-q')
        ? `${fixture.author}\n`
        : JSON.stringify({ id: 101, login: fixture.author, type: 'User' })
    if (typeof endpoint === 'string' && endpoint.startsWith(`${prefix}/actions/variables?`)) return variables(endpoint)
    return scopeResponse(endpoint)
  }
  function readOrWriteComments(args, endpoint) {
    if (args.includes('graphql') && args.some((arg) => String(arg).includes('... on IssueComment'))) return proof(args)
    return comments(args, endpoint)
  }

  return (args) => {
    if (args[0] !== 'api') return null
    const endpoint = args.find((arg) => String(arg).startsWith('repos/'))
    const metadata = readMetadata(args, endpoint)
    return metadata === null ? readOrWriteComments(args, endpoint) : metadata
  }
}

function commentPage(path) {
  const match = path.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments\?/)
  return match === null ? null : { issue: Number(match[1]), page: path.match(/[?&]page=(\d+)/)?.[1] ?? '1' }
}

function pullView(fields, fixture, state) {
  return JSON.stringify({
    ...(fields.includes('number') && { number: fixture.pr }),
    ...(fields.includes('headRefOid') && { headRefOid: state.head }),
    ...(fields.includes('headRefName') && { headRefName: 'feat/save' }),
    ...(fields.includes('state') && { state: 'OPEN' }),
    ...(fields.includes('labels') && { labels: state.label ? [{ name: 'reviewed' }] : [] }),
    ...(fields.includes('autoMergeRequest') && { autoMergeRequest: state.auto ? { enabledAt: 'now' } : null }),
    ...(fields.includes('mergeStateStatus') && { mergeStateStatus: 'CLEAN' }),
    ...(fields.includes('baseRefName') && { baseRefName: 'main' }),
    ...(fields.includes('baseRefOid') && { baseRefOid: fixture.heads[0] }),
    ...(fields.includes('author') && { author: { login: fixture.author } }),
    ...(fields.includes('body') && { body: '' }),
    ...(fields.includes('updatedAt') && { updatedAt: null }),
  })
}

function issueComments(page, history, issueHistory, fixture, historyPage) {
  if (page.page !== '1') return '[]'
  if (page.issue === fixture.issue) {
    if (issueHistory === null) throw new Error(`unexpected mandate history read for #${fixture.issue}`)
    return historyPage(issueHistory)
  }
  if (page.issue === fixture.pr) return historyPage(history)
  return null
}

function graphConnection(nodes) {
  return { nodes, pageInfo: { hasNextPage: false, endCursor: null } }
}

function nativeGraphResponse(args, fixture) {
  const query = args.find((arg) => String(arg).startsWith('query='))
  if (
    typeof query !== 'string' ||
    !query.includes('number title body updatedAt state stateReason repository') ||
    !query.includes('labels(first: 100, after: $labelsCursor)') ||
    !query.includes('subIssues(first: 100, after: $childrenCursor)') ||
    !query.includes('blockedBy(first: 100, after: $blockersCursor)')
  )
    return null
  const number = args.find((arg) => String(arg).startsWith('number='))
  if (number !== `number=${fixture.issue}`) throw new Error(`unexpected native graph issue: ${number}`)
  return JSON.stringify({
    data: {
      repository: {
        issue: {
          number: fixture.issue,
          title: 'Save selected region',
          body: fixture.spec,
          updatedAt: '2026-10-21T12:00:00Z',
          state: 'OPEN',
          stateReason: null,
          repository: { nameWithOwner: fixture.repository },
          parent: null,
          labels: graphConnection([{ name: 'size:S' }]),
          subIssues: graphConnection([]),
          blockedBy: graphConnection([]),
        },
      },
    },
  })
}

function apiResponse(args, history, issueHistory, fixture, historyPage) {
  if (args[1] === 'user') return `${fixture.author}\n`
  const nativeGraph = args.includes('graphql') ? nativeGraphResponse(args, fixture) : null
  if (nativeGraph !== null) return nativeGraph
  if (args.includes('graphql') && args.some((arg) => arg.includes('lastEditedAt')))
    return JSON.stringify({ data: { repository: { pullRequest: { body: '', lastEditedAt: null } } } })
  if (args[1] === `repos/${fixture.repository}/issues/${fixture.issue}`)
    return JSON.stringify({ number: fixture.issue, state: 'open', body: fixture.spec, user: { login: fixture.author } })
  if (args[1] === `repos/${fixture.repository}/issues/${fixture.pr}`)
    return JSON.stringify({ number: fixture.pr, state: 'open', body: '', user: { login: fixture.author } })
  const page = commentPage(String(args[1] ?? ''))
  return page === null ? null : issueComments(page, history, issueHistory, fixture, historyPage)
}

function publishComment(args, history, fixture) {
  const body = String(args.find((arg) => arg.startsWith('body=')) ?? '').slice('body='.length)
  const nativeId = String(fixture.nextCommentId())
  history.source.comments.push({
    locator: `published-${nativeId}`,
    nativeId,
    author: fixture.author,
    createdAt: '2026-01-01T00:03:00Z',
    updatedAt: '2026-01-01T00:03:00Z',
    body,
  })
  return JSON.stringify({ id: Number(nativeId), body, user: { login: fixture.author } })
}

function apiCommand(args, history, issueHistory, fixture, historyPage) {
  if (args[0] !== 'api') return null
  const response = apiResponse(args, history, issueHistory, fixture, historyPage)
  if (response !== null) return response
  return args.includes('POST') || (args.includes('--method') && args.includes('POST'))
    ? publishComment(args, history, fixture)
    : null
}

function issueView(args, fixture) {
  return args[0] === 'issue' && args[1] === 'view'
    ? JSON.stringify({
        body: fixture.spec,
        updatedAt: '2026-10-21T12:00:00Z',
        state: 'OPEN',
        labels: [{ name: 'size:S' }],
      })
    : null
}

function pullRequestView(args, fixture, state) {
  return args[0] === 'pr' && args[1] === 'view' ? pullView(String(args.at(-1)).split(','), fixture, state) : null
}

function disarmCommand(args, state) {
  if (args[0] !== 'pr') return null
  if (args[1] === 'merge' && args.includes('--disable-auto')) {
    state.auto = false
    return ''
  }
  if (args[1] === 'edit' && args.includes('--remove-label')) {
    state.label = false
    return ''
  }
  return null
}

export function createGateGh({ history, issueHistory, state, calls, fixture, historyPage }) {
  const authorization = authorizationTransport({ history, state, fixture, historyPage })
  return async (_cwd, args) => {
    calls.push(args)
    const fixtureCatalogue = fixtureCatalogueGhResponse(args)
    if (fixtureCatalogue !== null) return fixtureCatalogue
    const pinned = toolingGh(args)
    if (pinned !== null) return pinned.trim()
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: fixture.repository })
    for (const route of [
      () => authorization(args),
      () => apiCommand(args, history, issueHistory, fixture, historyPage),
      () => issueView(args, fixture),
      () => pullRequestView(args, fixture, state),
      () => disarmCommand(args, state),
    ]) {
      const response = route()
      if (response !== null) return response
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
}
