import { api } from './sim-api.ts'
import type { Context, Route } from './sim-command-context.ts'
import { emit, flags, one } from './sim-graphql.ts'
import { currentInvocation } from './sim-invocation.ts'
import { issue } from './sim-issue.ts'
import { pull } from './sim-pull.ts'
import { fail, fullName, type State } from './sim-types.ts'

function repoView(context: Context): boolean {
  if (context.cmd !== 'repo' || context.sub !== 'view') return false
  const reference = context.positionals[2]
  const repository = fullName(context.state)
  const name =
    reference === undefined || reference === context.state.origin || reference === repository
      ? repository
      : context.state.repositoryUrls?.[reference]
  if (!name) fail('gh: cannot resolve repository URL')
  emit({ nameWithOwner: name, defaultBranchRef: { name: context.state.defaultBranch } }, context.expression)
  return true
}

function run(context: Context): boolean {
  if (context.cmd !== 'run') return false
  if (context.sub === 'list') {
    emit([], context.expression)
    return true
  }
  if (context.sub === 'view') {
    context.writeStdout('\n')
    return true
  }
  return false
}

const ROUTES: readonly Route[] = [repoView, api, issue, pull, run]

export function handle(state: State, argv: string[]): void {
  state.calls.push(argv)
  const parsed = flags(argv)
  const invocation = currentInvocation()
  const context: Context = {
    ...parsed,
    state,
    argv,
    cmd: parsed.positionals[0],
    sub: parsed.positionals[1],
    expression: one(parsed.flag, '--jq'),
    cwd: invocation.cwd,
    readStdin: () => invocation.readStdin(),
    writeStdout: (text) => invocation.writeStdout(text),
  }
  for (const route of ROUTES) {
    if (route(context)) return
  }
  fail(`gh: unhandled ${argv.join(' ')}`)
}
