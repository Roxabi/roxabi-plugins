import { citedOperationIntegrity } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import { replayForMandate, type SpecIdentityReplay } from './uw-identity-replay.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec, AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import {
  contextSuccessionInspectionFrame,
  type HistoricalAcceptedSpecContext,
  historicalAcceptedSpecFrame,
  historicalAcceptedSpecOwnedHistories,
} from './workflow-context-succession-inspection.ts'
import { qualifyContextNegative } from './workflow-context-succession-negative.ts'
import { bindExternalRef, type ControlRecord, controlsOf, type MandateRecord, mandatesOf } from './workflow-control.ts'
import type { MandateSelection } from './workflow-mandate.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from './workflow-spec-authentication.ts'
import { terminalMandate } from './workflow-terminal-mandate.ts'

function diag(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}
function replayAcceptedSteps(
  spec: AcceptedOwnSpec,
  controls: readonly ControlRecord[],
  seen: ExternalRecordRef[],
  replay: SpecIdentityReplay,
  uw: Scope,
  diagnostics: UwDiagnostic[],
): void {
  for (const step of spec.chain) {
    if (step.kind !== 'accept-material' || seen.some((source) => sameRef(source, step.source))) continue
    seen.push(step.source)
    const control = controls.find((record) =>
      sameRef(step.source, {
        scope: { repository: record.repository, target: record.target },
        recordId: record.recordId,
        kind: record.kind,
      }),
    )
    if (control === undefined || control.payload.control !== 'accept-material') {
      diagnostics.push(diag(uw, 'spec-ledger-incomplete', `Accepted retirement ${step.source.recordId} is unreadable`))
      continue
    }
    for (const id of control.payload.identityDelta.retired) {
      if (!replay.allocations.has(id) || replay.retired.has(id))
        diagnostics.push(diag(uw, 'spec-ledger-conflict', `Accepted retirement ${id} is invalid`))
      else replay.retired.set(id, step.source)
    }
  }
}

export function replayAcceptedRetirements(
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
  replay: SpecIdentityReplay,
  uw: Scope,
  diagnostics: UwDiagnostic[],
  assessmentReplay?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): AcceptedOwnSpec[] {
  if (historical !== undefined) {
    const owned = historicalAcceptedSpecOwnedHistories(historical, histories)
    if (!owned.ok) {
      diagnostics.push(diag(uw, 'spec-ledger-incomplete', 'Historical observation is not authenticated'))
      return []
    }
    histories = owned.value
  }
  const authenticated: AcceptedOwnSpec[] = []
  const seen: ExternalRecordRef[] = []
  const controls = controlsOf(history).filter((record) => record.payload.control === 'accept-material')
  let replayMandateFound = false
  const selected = selectedMandate(history)
  for (const mandate of mandatesOf(history)) {
    const isReplayMandate = replayForMandate(history, mandate, assessmentReplay, inspection, histories)
    replayMandateFound ||= isReplayMandate
    const resolved = resolveRetirementMandate({
      mandate,
      histories,
      uw,
      diagnostics,
      historical,
      assessmentReplay,
      inspection,
      selected,
      isReplayMandate,
    })
    if (resolved === null) continue
    replayMandateFound ||= resolved.replayHere
    let result = resolved.result
    if (!result.ok) result = abandonedAssessmentRetirement(result, mandate, history, histories, historical)
    if (!result.ok) {
      diagnostics.push(
        diag(
          uw,
          'spec-ledger-incomplete',
          `Historical mandate ${mandate.recordId} cannot be authenticated: ${result.reason}`,
        ),
      )
      continue
    }
    authenticated.push(result.spec)
    replayAcceptedSteps(result.spec, controls, seen, replay, uw, diagnostics)
  }
  if (assessmentReplay !== undefined && equalScope(assessmentReplay.uw, uw) && !replayMandateFound)
    diagnostics.push(diag(uw, 'spec-ledger-incomplete', 'Assessment replay mandate is missing'))
  return authenticated
}

function resolveRetirementMandate(input: {
  mandate: MandateRecord
  histories: readonly DecodedHistory[]
  uw: Scope
  diagnostics: UwDiagnostic[]
  historical?: HistoricalAcceptedSpecContext
  assessmentReplay?: AssessmentReplayContext
  inspection?: AcceptedSpecInspection
  selected: MandateRecord | Extract<MandateSelection, { status: 'refused' }>
  isReplayMandate: boolean
}): { result: AcceptedSpecResult; replayHere: boolean } | null {
  const { mandate, histories, uw, diagnostics, historical, assessmentReplay, inspection, selected, isReplayMandate } =
    input
  const inspected = isInspectedRetirement(mandate, selected, inspection)
  if (historical !== undefined)
    return resolveHistoricalRetirement({
      mandate,
      histories,
      uw,
      diagnostics,
      historical,
      assessmentReplay,
      inspection: inspected ? inspection : undefined,
      selected,
    })
  if (
    inspection?.succession !== undefined &&
    'kind' in selected &&
    selected.kind === 'mandate' &&
    selected.recordId !== mandate.recordId
  ) {
    const result = resolveSuccessionRetirement(mandate, selected, histories, inspection.succession)
    if (result === null) {
      diagnostics.push(diag(uw, 'spec-ledger-incomplete', 'Succession inspection frame is not authenticated'))
      return null
    }
    return { result, replayHere: false }
  }
  const current = 'kind' in selected && selected.kind === 'mandate' && selected.recordId === mandate.recordId
  return {
    replayHere: false,
    result: resolveAcceptedSpec(
      mandate,
      histories,
      isReplayMandate || current ? assessmentReplay : undefined,
      inspected ? inspection : undefined,
    ),
  }
}

// This authenticates a prior assessment only for retirement replay, never current authority.
function abandonedAssessmentRetirement(
  result: AcceptedSpecResult,
  mandate: MandateRecord,
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
  historical?: HistoricalAcceptedSpecContext,
): AcceptedSpecResult {
  const terminal = terminalMandate(history)
  if (
    !terminal.ok ||
    !sameRef(terminal.value.ref, {
      scope: { repository: mandate.repository, target: mandate.target },
      kind: 'mandate',
      recordId: mandate.recordId,
    })
  )
    return result
  const ref = terminal.value.ref
  const abandonments = controlsOf(history).filter(
    (record) => record.payload.control === 'abandon' && sameRef(record.payload.mandate, ref),
  )
  const abandon = abandonments[0]
  const bound =
    abandon === undefined
      ? null
      : bindExternalRef({ scope: ref.scope, kind: 'operator-control', recordId: abandon.recordId }, history)
  if (
    abandonments.length !== 1 ||
    abandon === undefined ||
    !bound?.ok ||
    citedOperationIntegrity(history, abandon.recordId) !== null ||
    histories.some((part) =>
      part.operations.some((operation) => operation.authority !== 'foreign' && operation.status !== 'complete'),
    )
  )
    return result
  const qualified = qualifyContextNegative({ mandate, histories, historical })
  return qualified.ok && qualified.value.negativeLeaf.payload.action === 'assess-spec'
    ? { ok: true, spec: qualified.value.accepted }
    : result
}

function resolveHistoricalRetirement(input: {
  mandate: MandateRecord
  histories: readonly DecodedHistory[]
  uw: Scope
  diagnostics: UwDiagnostic[]
  historical: HistoricalAcceptedSpecContext
  assessmentReplay?: AssessmentReplayContext
  inspection?: AcceptedSpecInspection
  selected: MandateRecord | Extract<MandateSelection, { status: 'refused' }>
}): { result: AcceptedSpecResult; replayHere: boolean } | null {
  const { mandate, histories, uw, diagnostics, historical, assessmentReplay, inspection, selected } = input
  const frame = historicalAcceptedSpecFrame(historical, histories, mandate, inspection)
  if (!frame.ok) {
    diagnostics.push(diag(uw, 'spec-ledger-incomplete', 'Historical predecessor frame is not authenticated'))
    return null
  }
  const home = frame.value.histories.find((item) => equalScope(item.source.scope, uw))
  const replayHere =
    home !== undefined &&
    replayForMandate(home, mandate, assessmentReplay, frame.value.inspection, frame.value.histories)
  const currentFrame =
    frame.value.histories === histories &&
    'kind' in selected &&
    selected.kind === 'mandate' &&
    selected.recordId === mandate.recordId
  return {
    replayHere,
    result: resolveAcceptedSpec(
      mandate,
      frame.value.histories,
      replayHere || currentFrame ? assessmentReplay : undefined,
      frame.value.inspection,
      historical,
    ),
  }
}

function isInspectedRetirement(
  mandate: MandateRecord,
  selected: MandateRecord | Extract<MandateSelection, { status: 'refused' }>,
  inspection?: AcceptedSpecInspection,
): boolean {
  return inspection?.kind === 'context-negative-inspection'
    ? inspection.mandate.recordId === mandate.recordId &&
        equalScope(inspection.mandate.scope, { repository: mandate.repository, target: mandate.target })
    : inspection?.kind === 'selected-succession' &&
        'kind' in selected &&
        selected.kind === 'mandate' &&
        selected.recordId === mandate.recordId
}

function resolveSuccessionRetirement(
  mandate: MandateRecord,
  selected: MandateRecord,
  histories: readonly DecodedHistory[],
  succession: NonNullable<AcceptedSpecInspection['succession']>,
): AcceptedSpecResult | null {
  const successor = {
    scope: { repository: selected.repository, target: selected.target },
    kind: 'mandate' as const,
    recordId: selected.recordId,
  }
  const requested = {
    scope: { repository: mandate.repository, target: mandate.target },
    kind: 'mandate' as const,
    recordId: mandate.recordId,
  }
  const frame = contextSuccessionInspectionFrame(succession, histories, successor, requested)
  if (!frame.ok) return null
  return frame.value === undefined
    ? resolveAcceptedSpec(mandate, histories)
    : resolveAcceptedSpec(mandate, frame.value.histories, undefined, frame.value.inspection)
}
