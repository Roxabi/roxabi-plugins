import type { assessUwAdmission } from '../dist/contracts.js'
import type { UwRead } from './uw-contract.ts'
import { readCurrentChildrenProjection } from './uw-current-facts.ts'

export async function withTransitionAdmission(
  contracts: { assessUwAdmission: typeof assessUwAdmission },
  read: UwRead,
): Promise<UwRead> {
  if (!read.identity.ok) return read
  const currentChildren = await readCurrentChildrenProjection({ uw: read.uw, read })
  const result: UwRead = {
    ...read,
    admission: contracts.assessUwAdmission({
      uw: read.uw,
      graph: read.graph,
      proposed: read.proposed,
      accepted: read.accepted,
      identities: read.identity.value,
      histories: read.histories,
      catalogues: read.catalogues,
      completion: read.completion,
      phase: 'delivery-transition',
      currentChildren,
    }),
  }
  return result
}
