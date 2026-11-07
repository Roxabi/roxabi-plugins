import { assessUwCompletion, projectUwDelivery } from '../dist/contracts.js'
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
  return projectUwDelivery(observation, assessUwCompletion(observation), uw)
}
