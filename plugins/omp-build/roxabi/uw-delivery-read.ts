import { assessUwCompletion, createHistoricalAcceptedSpecContext, projectUwDelivery } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { UwDeliveryRead } from '../engine/uw-delivery-types.ts'
import type { UwResult } from '../engine/uw-diagnostics.ts'

export type { UwDeliveryDeclaration, UwDeliveryRead, UwDeliveryVerdict } from '../engine/uw-delivery-types.ts'
export type UwDeliveryReadPorts = {
  readObservation(uw: Scope): Promise<UwCompletionObservation>
}

/** Calculate and project from one observation, without a recursive live UW read. */
export async function readUwDelivery(uw: Scope, ports: UwDeliveryReadPorts): Promise<UwResult<UwDeliveryRead>> {
  const observation = await ports.readObservation(uw)
  if (observation.status === 'incomplete') return { ok: false, diagnostics: [...observation.diagnostics] }
  const historical = createHistoricalAcceptedSpecContext(observation.histories)
  if (!historical.ok)
    return {
      ok: false,
      diagnostics: historical.diagnostics.map((item) => ({
        code: item.code,
        message: item.message,
        location: { kind: 'native' as const, uw, connection: 'state' as const },
        related: [],
      })),
    }
  const completion = assessUwCompletion(observation, undefined, historical.value)
  return projectUwDelivery(observation, completion, uw, historical.value)
}
