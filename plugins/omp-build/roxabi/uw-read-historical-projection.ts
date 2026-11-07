import { createHash } from 'node:crypto'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { successionAntecedent } from './feature-succession.ts'
import type { UwRead } from './uw-contract.ts'
import { bindHistoricalProjection } from './uw-normalization-internal.ts'
import type { InstalledUwReadOptions } from './uw-read-port.ts'
import type { InstalledUwContracts } from './uw-read-state.ts'

export function bindEligibleHistoricalProjection(
  contracts: InstalledUwContracts,
  result: UwRead,
  own: DecodedHistory,
  histories: readonly DecodedHistory[],
  assessmentReplay?: InstalledUwReadOptions['assessmentReplay'],
): void {
  if (result.observation.status !== 'complete') return
  const selection = contracts.selectApplicableMandate(
    own,
    histories.filter((entry) => entry !== own),
    { histories, catalogues: result.catalogues, observation: result.observation },
  )
  if (
    result.accepted.status !== 'refused' ||
    selection.status !== 'refused' ||
    (selection.reason !== 'abandoned' && selection.reason !== 'revoked')
  )
    return
  const antecedent = successionAntecedent(own)
  if ('reason' in antecedent || antecedent.mandate.payload.format !== 'omp-build-mandate/4') return
  const historical = contracts.resolveAcceptedSpec(antecedent.mandate, histories, assessmentReplay)
  if (historical.ok)
    bindHistoricalProjection(
      result,
      historical.spec,
      createHash('sha256').update(JSON.stringify(histories)).digest('hex'),
    )
}
