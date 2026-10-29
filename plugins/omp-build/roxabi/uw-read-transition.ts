import type { assessUwAdmission } from '../dist/contracts.js'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { readCurrentChildrenProjection } from './uw-current-facts.ts'
import { bindHistoricalProjection, historicalProjection } from './uw-normalization-internal.ts'

export async function withTransitionAdmission(
  contracts: { assessUwAdmission: typeof assessUwAdmission },
  read: UwRead,
  reader: UwReadPort,
): Promise<UwRead> {
  if (!read.identity.ok) return read
  const currentChildren = await readCurrentChildrenProjection({ uw: read.uw, read, reader })
  const result: UwRead = {
    ...read,
    admission: contracts.assessUwAdmission({
      uw: read.uw,
      graph: read.graph,
      proposed: read.proposed,
      accepted: read.accepted,
      identities: read.identity.value,
      phase: 'delivery-transition',
      currentChildren,
    }),
  }
  const historical = historicalProjection(read)
  if (historical !== undefined) bindHistoricalProjection(result, historical.accepted, historical.historyDigest)
  return result
}
