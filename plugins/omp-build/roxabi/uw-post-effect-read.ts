import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { UwOperationResult, UwRead } from './uw-contract.ts'
import { UwGraphUnavailableError } from './uw-read-port.ts'

function postEffectDiagnostics(uw: Scope, error: unknown): readonly UwDiagnostic[] {
  if (error instanceof UwGraphUnavailableError) return error.diagnostics
  return [
    {
      code: 'post-effect-read-failed',
      message: error instanceof Error ? error.message : 'UW read failed after durable effects',
      location: { kind: 'native', uw, connection: 'state' },
      related: [],
    },
  ]
}

export async function readAfterEffect(
  status: 'written' | 'created',
  uw: Scope,
  read: () => Promise<UwRead>,
): Promise<UwOperationResult> {
  try {
    return { status, value: await read() }
  } catch (error) {
    return { status: 'partial', uw, diagnostics: postEffectDiagnostics(uw, error) }
  }
}
