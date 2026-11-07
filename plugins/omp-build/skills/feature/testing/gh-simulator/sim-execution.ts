import { probeCount, probeOperation, probeScope, probeStart } from '../../../../testing/diagnostic-probe.ts'
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
  const start = process.hrtime.bigint()
  const scope = probeScope(input.env?.GH_SIM_STATE ?? process.env.GH_SIM_STATE)
  const operation = probeOperation(argv)
  probeStart(scope, 'sim-command', operation)
  let failed = true
  try {
    const result = runInvocation(input, (invocation) => {
      try {
        withState((state) => handle(state, argv))
        return { status: 0 as const, stdout: invocation.stdout, stderr: invocation.stderr }
      } catch (error) {
        invocation.writeStderr(`${failureText(argv, error)}\n`)
        return { status: 1 as const, stdout: invocation.stdout, stderr: invocation.stderr }
      }
    })
    failed = result.status !== 0
    return result
  } finally {
    probeCount(scope, 'sim-command', operation, Number(process.hrtime.bigint() - start), 0, failed, true)
  }
}
