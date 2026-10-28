import { handle } from './sim-command.ts'
import { runInvocation, type SimCommandInput } from './sim-invocation.ts'
import { withState } from './sim-state.ts'

export type { SimCommandInput } from './sim-invocation.ts'

export type SimCommandResult = {
  status: 0 | 1
  stdout: string
  stderr: string
}

function failureText(argv: string[], error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('match-head-commit') || message.startsWith('auto-merge') || message.startsWith('gh:')
    ? message
    : `gh: ${message}\n${argv.join(' ')}`
}

export function executeSimCommand(argv: string[], input: SimCommandInput): SimCommandResult {
  return runInvocation(input, (invocation) => {
    try {
      withState((state) => handle(state, argv))
      return { status: 0, stdout: invocation.stdout, stderr: invocation.stderr }
    } catch (error) {
      invocation.writeStderr(`${failureText(argv, error)}\n`)
      return { status: 1, stdout: invocation.stdout, stderr: invocation.stderr }
    }
  })
}
