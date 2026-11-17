import type { Context } from './sim-command-context.ts'
import { emit, one } from './sim-graphql.ts'
import { fail } from './sim-types.ts'

export function apiIssueGet(context: Context): boolean {
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
