import { githubScope } from '../dist/contracts.js'
import type { UwOperations } from '../roxabi/uw-contract.ts'
import { UwGraphUnavailableError } from '../roxabi/uw-read-port.ts'

export async function executeRead(
  repository: string,
  number: number,
  operations: UwOperations,
): Promise<{ kind: 'result'; value: unknown }> {
  try {
    const current = await operations.readUw(githubScope(repository, number))
    if (current.fixRecovery.status !== 'interrupted') return { kind: 'result', value: current }
    const request = current.fixRecovery.phase.request
    const requestScope = 'reservation' in request ? request.reservation.scope : request.identity.scope
    const match = /#([1-9]\d*)$/.exec(requestScope.target)
    const pr = match === null ? NaN : Number(match[1])
    if (!Number.isSafeInteger(pr) || pr <= 0) return { kind: 'result', value: current }
    return {
      kind: 'result',
      value: {
        ...current,
        fixRecoveryHint: {
          tool: 'omp_build_recover_interrupted_fix',
          parameters: { pr },
          note: 'Interrupted ownership observed; recovery eligibility and current authority must still be verified.',
        },
      },
    }
  } catch (error) {
    if (error instanceof UwGraphUnavailableError)
      return { kind: 'result', value: { status: 'refused', diagnostics: error.diagnostics } }
    throw error
  }
}
