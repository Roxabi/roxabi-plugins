import { existsSync, writeFileSync } from 'node:fs'

import type { Context, Route } from './sim-command-context.ts'
import { recordedBase, tip } from './sim-git.ts'
import { commentsForNumber, commentThreadForNumber, emit, graphql, one, varsOf } from './sim-graphql.ts'
import { closesOf, fail, fullName, type Pull, stamp } from './sim-types.ts'

function duplicatePullRequestFailure(context: Context, head: string): never {
  const payload = {
    message: 'Validation Failed',
    errors: [
      {
        resource: 'PullRequest',
        code: 'custom',
        message: `A pull request already exists for ${context.state.owner}:${head}.`,
      },
    ],
    documentation_url: 'https://docs.github.com/rest/pulls/pulls#create-a-pull-request',
  }
  fail(`HTTP 422: ${JSON.stringify(payload)}`)
}

function apiUser(context: Context): boolean {
  if (context.sub !== 'user') return false
  if (context.state.appInstallation) fail('Resource not accessible by integration (HTTP 403)')
  emit({ login: context.state.viewer }, context.expression)
  return true
}

function apiGraphql(context: Context): boolean {
  if (context.sub !== 'graphql') return false
  const form = varsOf(context.flag)
  emit(graphql(context.state, form.query ?? '', form), context.expression)
  return true
}

function apiCreatePull(context: Context): boolean {
  if (one(context.flag, '--method') !== 'POST' || !(context.sub ?? '').endsWith('/pulls')) return false
  const form = varsOf(context.flag)
  const head = form.head ?? ''
  const base = form.base ?? context.state.defaultBranch
  const sha = tip(context.state.origin, head)
  if (!sha) fail(`gh: head ${head} is not on ${context.state.origin}`)
  const existing = Object.values(context.state.prs).find(
    (pr) => pr.state === 'OPEN' && pr.headRefName === head && pr.baseRefName === base,
  )
  if (existing) duplicatePullRequestFailure(context, head)
  const number = context.state.nextPr
  context.state.nextPr += 1
  const pr: Pull = {
    number,
    title: form.title ?? '',
    body: form.body ?? '',
    state: 'OPEN',
    headRefName: head,
    baseRefName: base,
    headRefOid: sha,
    isCrossRepository: false,
    labels: [],
    autoMerge: null,
    mergeCommit: null,
    mergedAt: null,
    comments: [],
    closes: closesOf(form.body ?? ''),
  }
  context.state.prs[String(number)] = pr
  recordedBase(context.state, pr)
  emit({ number, html_url: `https://example.test/${fullName(context.state)}/pull/${number}` }, context.expression)
  return true
}

function apiIssueGet(context: Context): boolean {
  const issueGet = context.sub?.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/)
  if (!issueGet || one(context.flag, '--method') !== undefined) return false
  const number = issueGet[1] ?? ''
  const pr = context.state.prs[number]
  if (pr) {
    emit(
      {
        number: pr.number,
        state: pr.state === 'OPEN' ? 'open' : 'closed',
        body: pr.body,
        user: { login: context.state.viewer },
        title: pr.title,
      },
      context.expression,
    )
    return true
  }
  const issue = context.state.issues[number]
  if (issue) {
    emit(
      {
        number: issue.number,
        state: issue.state.toLowerCase(),
        body: issue.body,
        user: { login: issue.author },
        title: issue.title,
      },
      context.expression,
    )
    return true
  }
  fail(`gh: issue #${number} not found`)
}

function commentPath(context: Context): RegExpMatchArray | undefined {
  const path = context.sub?.match(/^repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments(?:\?([^#]*))?$/)
  return path ?? undefined
}

function pauseCommentPost(body: string): void {
  const match = process.env.GH_SIM_COMMENT_BARRIER_MATCH
  const started = process.env.GH_SIM_COMMENT_BARRIER_STARTED
  const release = process.env.GH_SIM_COMMENT_BARRIER_RELEASE
  if (!match || !started || !release || !body.includes(match)) return
  writeFileSync(started, 'started\n')
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(release)) Atomics.wait(sleeper, 0, 0, 10)
}
function apiCommentPost(context: Context): boolean {
  const path = commentPath(context)
  if (!path || one(context.flag, '--method') !== 'POST') return false
  const thread = commentThreadForNumber(context.state, path[1] ?? '')
  const body = varsOf(context.flag).body
  if (thread === undefined || body === undefined)
    fail(`gh: ${body === undefined ? 'missing comment body' : 'issue not found'}`)
  pauseCommentPost(body)
  const id = (context.state.nextCommentId ?? 0) + 1
  context.state.nextCommentId = id
  const createdAt = stamp(context.state)
  thread.comments.push({ id, author: context.state.viewer, body, createdAt, updatedAt: createdAt })
  emit(
    { id, user: { login: context.state.viewer }, body, created_at: createdAt, updated_at: createdAt },
    context.expression,
  )
  return true
}

function apiCommentList(context: Context): boolean {
  const path = commentPath(context)
  if (!path || context.bool.has('--paginate')) return false
  const number = path[1] ?? ''
  const query = new URLSearchParams(path[2] ?? '')
  const perPage = Number(query.get('per_page') ?? '30')
  const page = Number(query.get('page') ?? '1')
  if (!Number.isSafeInteger(perPage) || perPage < 1 || !Number.isSafeInteger(page) || page < 1) {
    fail('gh: invalid comment pagination')
  }
  const rows = commentsForNumber(context.state, number)
    .slice((page - 1) * perPage, page * perPage)
    .map((comment) => ({
      id: comment.id,
      user: { login: comment.author },
      body: comment.body,
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
    }))
  emit(rows, context.expression)
  return true
}

function apiCommentPages(context: Context): boolean {
  if (!context.bool.has('--paginate') || !context.bool.has('--slurp') || !context.sub?.endsWith('/comments'))
    return false
  const number = context.sub.match(/issues\/(\d+)\/comments$/)?.[1]
  if (!number) fail(`gh: unhandled ${context.argv.join(' ')}`)
  const page = commentsForNumber(context.state, number).map((comment) => ({
    id: comment.id,
    user: { login: comment.author },
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  }))
  process.stdout.write(`${JSON.stringify([page])}\n`)
  return true
}

function apiEvents(context: Context): boolean {
  if (!context.sub?.includes('/events')) return false
  const number = context.sub.match(/issues\/(\d+)\/events/)?.[1]
  if (!number) fail(`gh: unhandled ${context.argv.join(' ')}`)
  emit(context.state.events[number] ?? [], context.expression)
  return true
}

function apiEmptyResponses(context: Context): boolean {
  if (context.sub?.includes('/protection/required_status_checks')) {
    emit({ required_status_checks: { contexts: [] } }, context.expression)
    return true
  }
  if (context.sub?.includes('/rules/branches/')) {
    emit([], context.expression)
    return true
  }
  if (context.sub?.includes('/check-runs')) {
    emit({ check_runs: [] }, context.expression)
    return true
  }
  return false
}

const API_ROUTES: readonly Route[] = [
  apiUser,
  apiGraphql,
  apiCreatePull,
  apiIssueGet,
  apiCommentPost,
  apiCommentList,
  apiCommentPages,
  apiEvents,
  apiEmptyResponses,
]

export function api(context: Context): boolean {
  if (context.cmd !== 'api') return false
  for (const route of API_ROUTES) {
    if (route(context)) return true
  }
  return false
}
