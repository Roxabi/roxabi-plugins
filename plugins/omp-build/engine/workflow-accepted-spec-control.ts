import type { DecodedHistory } from './history-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import { createHistoricalAcceptedSpecContext } from './workflow-context-succession-inspection.ts'
import { qualifyContextNegative } from './workflow-context-succession-negative.ts'
import type { MandateRecord } from './workflow-control.ts'

/** Inspect an authenticated assessment-negative prefix only for abandonment. */
export function resolveAcceptedSpecForAbandonment(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
): AcceptedSpecResult {
  const historical = createHistoricalAcceptedSpecContext(histories)
  if (!historical.ok) return { ok: false, reason: 'incomplete', evidence: historical.diagnostics }
  const ordinary = resolveAcceptedSpec(mandate, histories, undefined, undefined, historical.value)
  if (ordinary.ok) return ordinary
  const qualified = qualifyContextNegative({ mandate, histories, historical: historical.value })
  if (!qualified.ok || qualified.value.negativeLeaf.payload.action !== 'assess-spec') return ordinary
  return { ok: true, spec: qualified.value.accepted }
}
