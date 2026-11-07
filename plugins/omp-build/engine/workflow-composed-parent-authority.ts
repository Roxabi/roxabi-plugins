import type { DecodedHistory } from './history-schema.ts'
import { sameOwnSpecRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { compositionStale, sameObservationValue } from './workflow-composed-observation.ts'
import { historyFor } from './workflow-control.ts'
import { resolveCurrentInheritedOwnSpecRefs } from './workflow-current-inheritance.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import type { MaterialAcceptanceInput } from './workflow-material-acceptance.ts'
import type { MaterialAcceptanceProposal } from './workflow-spec-assessment.ts'

export function readConsentAuthority(
  material: MaterialAcceptanceInput,
  observation: UwCompletionObservation,
  proposal: MaterialAcceptanceProposal,
): Result<{ accepted: AcceptedOwnSpec; effective: SpecEffective; history: DecodedHistory }> {
  const accepted = resolveAcceptedSpec(material.mandate, observation.histories)
  if (!accepted.ok || !sameOwnSpecRef(accepted.spec.ref, proposal.exactInputs.accepted.ref))
    return compositionStale('Current accepted parent differs from the assessment')
  const history = historyFor(material.uw, observation.histories)
  if (history === null || !history.source.complete) return compositionStale('Complete parent history is required')
  const selected = selectedMandate(history)
  if (!('kind' in selected) || selected.kind !== 'mandate' || selected.recordId !== material.mandate.recordId)
    return compositionStale('Parent mandate is not the uniquely active current mandate')
  const effective = resolveSpecEffective({
    mode: 'historical',
    own: accepted.spec.ref,
    versionVector: [accepted.spec.ref, ...accepted.spec.inheritedOwnSpecRefs],
    histories: observation.histories,
  })
  if (!effective.ok) return compositionStale('Historical accepted parent authority is unavailable')
  const proposed = resolveCurrentInheritedOwnSpecRefs(material.uw, observation.graph, observation.histories)
  if (!proposed.ok || !sameObservationValue(proposed.value, proposal.exactInputs.proposed.inheritedOwnSpecRefs))
    return compositionStale('Proposed inheritance differs from current authenticated native ancestry')
  return { ok: true, value: { accepted: accepted.spec, effective: effective.value, history } }
}
