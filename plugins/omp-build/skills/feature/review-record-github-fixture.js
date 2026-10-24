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

function apiResponse(args, history, issueHistory, fixture, historyPage) {
  if (args[1] === 'user') return `${fixture.author}\n`
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
  const nativeId = String(history.source.comments.length + 1)
  history.source.comments.push({
    locator: `published-${nativeId}`,
    nativeId,
    author: fixture.author,
    createdAt: '2026-01-01T00:03:00Z',
    updatedAt: null,
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
    ? JSON.stringify({ body: fixture.spec, updatedAt: '2026-10-21T12:00:00Z', state: 'OPEN', labels: [] })
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
  return async (_cwd, args) => {
    calls.push(args)
    if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({ nameWithOwner: fixture.repository })
    const api = apiCommand(args, history, issueHistory, fixture, historyPage)
    if (api !== null) return api
    const issue = issueView(args, fixture)
    if (issue !== null) return issue
    const pullRequest = pullRequestView(args, fixture, state)
    if (pullRequest !== null) return pullRequest
    const disarmed = disarmCommand(args, state)
    if (disarmed !== null) return disarmed
    throw new Error(`unexpected gh call: ${args.join(' ')}`)
  }
}
