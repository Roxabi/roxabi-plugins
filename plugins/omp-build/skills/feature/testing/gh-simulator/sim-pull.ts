import { readFileSync } from 'node:fs'
import type { Context, Route } from './sim-command-context.ts'
import { refreshHead, settle, settleAll } from './sim-git.ts'
import { emit, fields, one } from './sim-graphql.ts'
import { closesOf, fail, fullName, GITHUB_COMMENT_LIMIT, type Pull, stamp } from './sim-types.ts'

function requirePr(context: Context): Pull {
  const number = context.positionals[2] ?? ''
  const pr = context.state.prs[number]
  if (!pr) fail(`gh: pull request #${number} not found`)
  return pr
}

function commentBody(context: Context): string {
  const file = one(context.flag, '--body-file')
  const body =
    file === '-' ? readFileSync(0, 'utf8') : file ? readFileSync(file, 'utf8') : (one(context.flag, '--body') ?? '')
  if (body.length > GITHUB_COMMENT_LIMIT) {
    fail(`GraphQL: Body is too long (maximum is ${GITHUB_COMMENT_LIMIT} characters) (addComment)`)
  }
  return body
}

function prList(context: Context): boolean {
  if (context.sub !== 'list') return false
  settleAll(context.state)
  const head = one(context.flag, '--head')
  const base = one(context.flag, '--base')
  const wanted = one(context.flag, '--state') ?? 'open'
  const rows = Object.values(context.state.prs)
    .filter((pr) => (head ? pr.headRefName === head : true))
    .filter((pr) => (base ? pr.baseRefName === base : true))
    .filter((pr) => (wanted === 'all' ? true : pr.state === wanted.toUpperCase()))
    .map((pr) => fields(context.flag, pr, context.state))
  emit(rows, context.expression)
  return true
}

function prView(context: Context): boolean {
  if (context.sub !== 'view') return false
  const pr = requirePr(context)
  settle(context.state, pr)
  emit(fields(context.flag, pr, context.state), context.expression)
  return true
}

function prComment(context: Context): boolean {
  if (context.sub !== 'comment') return false
  const pr = requirePr(context)
  const body = commentBody(context)
  pr.comments.push({ author: context.state.viewer, body, createdAt: stamp(context.state) })
  process.stdout.write(
    `https://example.test/${fullName(context.state)}/pull/${pr.number}#issuecomment-${pr.comments.length}\n`,
  )
  return true
}

function editedBody(context: Context): string | undefined {
  const file = one(context.flag, '--body-file')
  if (file === '-') return readFileSync(0, 'utf8')
  if (file) return readFileSync(file, 'utf8')
  return one(context.flag, '--body')
}

function prEdit(context: Context): boolean {
  if (context.sub !== 'edit') return false
  const pr = requirePr(context)
  const add = one(context.flag, '--add-label')
  if (add && !pr.labels.includes(add)) {
    pr.labels.push(add)
    const events = context.state.events[String(pr.number)] ?? []
    events.push({ event: 'labeled', label: { name: add }, created_at: stamp(context.state) })
    context.state.events[String(pr.number)] = events
  }
  const remove = one(context.flag, '--remove-label')
  if (remove) pr.labels = pr.labels.filter((label) => label !== remove)
  const body = editedBody(context)
  if (body !== undefined) {
    pr.body = body
    pr.closes = closesOf(body)
    pr.lastEditedAt = stamp(context.state)
  }
  process.stdout.write(`https://example.test/${fullName(context.state)}/pull/${pr.number}\n`)
  return true
}

function prMerge(context: Context): boolean {
  if (context.sub !== 'merge') return false
  const pr = requirePr(context)
  if (context.bool.has('--disable-auto')) {
    pr.autoMerge = null
    process.stdout.write('\n')
    return true
  }
  if (!context.bool.has('--auto') || !context.bool.has('--merge')) return false
  const pin = one(context.flag, '--match-head-commit')
  refreshHead(context.state, pr)
  if (pin !== undefined && pin !== pr.headRefOid) {
    fail(`match-head-commit ${pin} does not match head ${pr.headRefOid}`)
  }
  if (pr.autoMerge) fail('auto-merge already enabled')
  pr.autoMerge = { enabledAt: stamp(context.state), ...(pin ? { matchHeadCommit: pin } : {}) }
  process.stdout.write('\n')
  return true
}

const PR_ROUTES: readonly Route[] = [prList, prView, prComment, prEdit, prMerge]

export function pull(context: Context): boolean {
  if (context.cmd !== 'pr') return false
  for (const route of PR_ROUTES) {
    if (route(context)) return true
  }
  return false
}
