import type { Context } from './sim-command-context.ts'
import { emit } from './sim-graphql.ts'
import { fail } from './sim-types.ts'

export function apiVariables(context: Context, path: string, repo: string): boolean {
  if (context.state.authorizationVariablesForbidden) fail('gh: repository variables unavailable (HTTP 403)')
  const query = new URLSearchParams(path.slice(path.indexOf('?') + 1))
  const page = Number(query.get('page') ?? '1')
  const perPage = Number(query.get('per_page') ?? '30')
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(perPage) || perPage < 1)
    fail('gh: invalid variable pagination')
  const variables = Object.entries(
    context.state.authorizationVariables ?? {
      HEAD_AUTH_REPOSITORY_ID: String(context.state.repositoryId ?? 1),
      HEAD_AUTH_OPERATOR_IDS: '[101]',
      HEAD_AUTH_APP_ID: '200',
      HEAD_AUTH_BOT_USER_ID: '201',
    },
  ).map(([name, value]) => ({ name, value }))
  const rows = variables.slice((page - 1) * perPage, page * perPage)
  const payload = { total_count: variables.length, variables: rows }
  if (context.bool.has('--include')) {
    const link =
      variables.length > page * perPage
        ? `Link: <https://api.github.com/${repo}/actions/variables?per_page=${perPage}&page=${page + 1}>; rel="next"\r\n`
        : ''
    context.writeStdout(`HTTP/2 200\r\nContent-Type: application/json\r\n${link}\r\n${JSON.stringify(payload)}\n`)
  } else emit(payload, context.expression)
  return true
}
