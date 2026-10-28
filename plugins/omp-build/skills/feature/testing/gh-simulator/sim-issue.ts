import { type Context, readBodyFile } from './sim-command-context.ts'
import { commentThreadForNumber, emit, one } from './sim-graphql.ts'
import { fail, fullName, GITHUB_COMMENT_LIMIT, stamp } from './sim-types.ts'

function commentBody(context: Context): string {
  const file = one(context.flag, '--body-file')
  const body = file ? readBodyFile(context, file) : (one(context.flag, '--body') ?? '')
  if (body.length > GITHUB_COMMENT_LIMIT) {
    fail(`GraphQL: Body is too long (maximum is ${GITHUB_COMMENT_LIMIT} characters) (addComment)`)
  }
  return body
}

function issueView(context: Context): boolean {
  if (context.sub !== 'view') return false
  const repo = one(context.flag, '--repo')
  if (repo !== undefined && repo !== fullName(context.state)) {
    fail(`gh: issue view repo ${repo} is not ${fullName(context.state)}`)
  }
  const number = context.positionals[2] ?? ''
  const issue = context.state.issues[number]
  if (!issue) fail(`gh: issue #${number} not found`)
  const wanted = (one(context.flag, '--json') ?? '').split(',').filter(Boolean)
  const all = {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    updatedAt: issue.updatedAt ?? null,
    labels: issue.labels.map((name) => ({ name })),
    author: { login: issue.author },
  }
  type IssueViewField = keyof typeof all
  const selected: IssueViewField[] = wanted.length
    ? wanted.filter((key): key is IssueViewField => Object.hasOwn(all, key))
    : (Object.keys(all) as IssueViewField[])
  const projected: Record<string, unknown> = {}
  for (const key of selected) projected[key] = all[key] ?? null
  emit(projected, context.expression)
  return true
}

function issueComment(context: Context): boolean {
  if (context.sub !== 'comment') return false
  const number = context.positionals[2] ?? ''
  const thread = commentThreadForNumber(context.state, number)
  if (!thread) fail(`gh: issue #${number} not found`)
  const body = commentBody(context)
  thread.comments.push({ author: context.state.viewer, body, createdAt: stamp(context.state) })
  context.writeStdout(
    `https://example.test/${fullName(context.state)}/issues/${number}#issuecomment-${thread.comments.length}\n`,
  )
  return true
}

export function issue(context: Context): boolean {
  if (context.cmd !== 'issue') return false
  return issueView(context) || issueComment(context)
}
