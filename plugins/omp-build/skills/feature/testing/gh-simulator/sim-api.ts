import { existsSync, writeFileSync } from 'node:fs'

import { apiVariables } from './sim-authorization-variables.ts'
import type { Context, Route } from './sim-command-context.ts'
import { recordedBase, tip } from './sim-git.ts'
import { commentsForNumber, commentThreadForNumber, emit, graphql, one, varsOf } from './sim-graphql.ts'
import { toolingBlobRoute } from './sim-tooling.ts'
import type { Comment } from './sim-types.ts'
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
  emit({ login: context.state.viewer, id: context.state.viewerId ?? 101, type: 'User' }, context.expression)
  return true
}

function apiGraphql(context: Context): boolean {
  if (context.sub !== 'graphql') return false
  const form = varsOf(context.flag)
  emit(graphql(context.state, form.query ?? '', form), context.expression)
  return true
}

function apiAuthorizationPull(context: Context, path: string): boolean {
  const match = path.match(/^repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/)
  if (!match || match[1] !== context.state.owner || match[2] !== context.state.name) return false
  const pr = context.state.prs[match[3] ?? '']
  if (!pr) fail('gh: pull request not found (HTTP 404)')
  emit(
    {
      id: pr.databaseId ?? 1000 + pr.number,
      node_id: pr.nodeId ?? `PR_${pr.number}`,
      number: pr.number,
      state: pr.state === 'OPEN' ? 'open' : 'closed',
      user: { id: pr.authorId ?? context.state.viewerId ?? 101, login: context.state.viewer, type: 'User' },
      head: { sha: pr.headRefOid },
      base: {
        ref: pr.baseRefName,
        sha: pr.baseRefOid ?? recordedBase(context.state, pr),
        repo: { id: context.state.repositoryId ?? 1 },
      },
    },
    context.expression,
  )
  return true
}

function apiAuthorizationScope(context: Context): boolean {
  const path = context.sub ?? ''
  const repo = `repos/${context.state.owner}/${context.state.name}`
  if (one(context.flag, '--method') !== undefined) return false
  if (path.startsWith(`${repo}/actions/variables?`)) return apiVariables(context, path, repo)
  if (path === repo) {
    emit(
      {
        id: context.state.repositoryId ?? 1,
        node_id: context.state.repositoryNodeId ?? 'R_1',
        full_name: fullName(context.state),
      },
      context.expression,
    )
    return true
  }
  if (path.startsWith(`${repo}/git/ref/heads/`)) {
    const branch = path.slice(`${repo}/git/ref/heads/`.length).split('/').map(decodeURIComponent).join('/')
    const sha = context.state.remoteRefs?.[branch] ?? tip(context.state.origin, branch)
    if (!sha) fail('gh: ref not found (HTTP 404)')
    emit({ ref: `refs/heads/${branch}`, object: { sha } }, context.expression)
    return true
  }
  return apiAuthorizationPull(context, path)
}

function restComment(context: Context, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: comment.nodeId ?? `IC_${comment.id}`,
    user: {
      login: comment.author,
      id: comment.userId ?? context.state.viewerId ?? 101,
      type: comment.appId == null ? 'User' : 'Bot',
    },
    performed_via_github_app: comment.appId == null ? null : { id: comment.appId },
    body: comment.body,
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  }
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
  if (context.state.commentPostForbidden) fail('Resource not accessible by integration (HTTP 403)')
  const thread = commentThreadForNumber(context.state, path[1] ?? '')
  const body = varsOf(context.flag).body
  if (thread === undefined || body === undefined)
    fail(`gh: ${body === undefined ? 'missing comment body' : 'issue not found'}`)
  pauseCommentPost(body)
  const id = (context.state.nextCommentId ?? 0) + 1
  context.state.nextCommentId = id
  const createdAt = stamp(context.state)
  const comment = {
    id,
    author: context.state.viewer,
    userId: context.state.viewerId ?? 101,
    body,
    createdAt,
    updatedAt: createdAt,
  }
  thread.comments.push(comment)
  emit(restComment(context, comment), context.expression)
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
  if (context.state.commentReadFailurePage === page) fail('gh: comment page unavailable (HTTP 503)')
  const rows = commentsForNumber(context.state, number)
    .slice((page - 1) * perPage, page * perPage)
    .map((comment) => restComment(context, comment))
  if (context.bool.has('--include')) {
    const more = commentsForNumber(context.state, number).length > page * perPage
    const link = more
      ? `Link: <https://api.github.com/repos/${fullName(context.state)}/issues/${number}/comments?per_page=${perPage}&page=${page + 1}>; rel="next"\r\n`
      : ''
    context.writeStdout(`HTTP/2 200\r\nContent-Type: application/json\r\n${link}\r\n${JSON.stringify(rows)}\n`)
  } else emit(rows, context.expression)
  return true
}

function apiCommentPages(context: Context): boolean {
  if (!context.bool.has('--paginate') || !context.bool.has('--slurp') || !context.sub?.endsWith('/comments'))
    return false
  const number = context.sub.match(/issues\/(\d+)\/comments$/)?.[1]
  if (!number) fail(`gh: unhandled ${context.argv.join(' ')}`)
  const page = commentsForNumber(context.state, number).map((comment) => restComment(context, comment))
  context.writeStdout(`${JSON.stringify([page])}\n`)
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
  toolingBlobRoute,
  apiUser,
  apiGraphql,
  apiAuthorizationScope,
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
