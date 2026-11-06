import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { CreatedUwRead, UwOperationResult, UwRead } from './uw-contract.ts'
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
  status: 'created',
  uw: Scope,
  read: () => Promise<CreatedUwRead>,
): Promise<UwOperationResult>
export async function readAfterEffect(
  status: 'written',
  uw: Scope,
  read: () => Promise<UwRead>,
): Promise<UwOperationResult>
export async function readAfterEffect(
  status: 'written' | 'created',
  uw: Scope,
  read: () => Promise<CreatedUwRead>,
): Promise<UwOperationResult> {
  try {
    const value = await read()
    return status === 'created' ? { status, value } : { status, value: value as UwRead }
  } catch (error) {
    return { status: 'partial', uw, diagnostics: postEffectDiagnostics(uw, error) }
  }
}
