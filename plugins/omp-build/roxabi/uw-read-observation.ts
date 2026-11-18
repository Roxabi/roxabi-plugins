import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { InstalledUwContracts } from './uw-read-state.ts'

function projectObservation(
  contracts: InstalledUwContracts,
  observation: UwCompletionObservation,
): UwCompletionObservation {
  const projected = contracts.projectRecoveryHistories(observation.histories)
  if (projected.ok) return { ...observation, histories: projected.value }
  const refusal: UwDiagnostic = {
    code: 'recovery-projection-refused',
    message: projected.diagnostics.map((entry) => entry.message).join('; '),
    location: { kind: 'native', uw: observation.root, connection: 'state' },
    related: [],
  }
  const diagnostics: [UwDiagnostic, ...UwDiagnostic[]] = [refusal]
  if (observation.status === 'incomplete') diagnostics.unshift(...observation.diagnostics)
  return { ...observation, status: 'incomplete', diagnostics }
}

/** Bind the projected histories once, before any reader consumer receives the observation. */
export function prepareUwReadObservation(contracts: InstalledUwContracts, input: UwCompletionObservation) {
  let observation = projectObservation(contracts, input)
  const prepared =
    observation.status === 'complete' ? contracts.createHistoricalAcceptedSpecContext(observation.histories) : null
  const bound = prepared?.ok
    ? contracts.historicalAcceptedSpecOwnedHistories(prepared.value, observation.histories)
    : prepared
  if (bound?.ok) observation = { ...observation, histories: bound.value }
  else if (bound !== null) {
    observation = {
      ...observation,
      status: 'incomplete',
      diagnostics: [
        {
          code: 'history-unconfirmed',
          message: 'Historical Spec context cannot be authenticated',
          location: { kind: 'native', uw: observation.root, connection: 'state' },
          related: [],
        },
      ],
    }
  }
  return { observation, historical: prepared?.ok ? prepared.value : undefined }
}
