import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { UwDiagnostic, UwResult } from './uw-diagnostics.ts'
import { buildNewSpecAllocationPlan, buildSpecAllocationPlan } from './uw-identity-allocation.ts'
import { replayForMandate, replaySpecIdentityHistory, type SpecIdentityReplay } from './uw-identity-replay.ts'
import type { Spec, SpecDraft, SpecItemId } from './uw-spec.ts'
import { specDraftSchema } from './uw-spec-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { type ControlRecord, controlsOf, mandatesOf } from './workflow-control.ts'
import type { AssessmentReplayContext } from './workflow-spec-authentication.ts'
export type SpecIdentityLedger = {
  uw: Scope
  head: ExternalRecordRef | null
  nextCriterion: string
  nextInvariant: string
  allocations: ReadonlyMap<SpecItemId, ExternalRecordRef>
  retired: ReadonlyMap<SpecItemId, ExternalRecordRef>
}
export type SpecAllocationPlan = {
  ledgerHead: ExternalRecordRef | null
  assignments: readonly { draftKey: string; id: SpecItemId }[]
  retirements: readonly SpecItemId[]
  spec: Spec
}
function diag(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function acceptedIds(accepted: AcceptedOwnSpec | null): Set<SpecItemId> {
  return new Set(
    accepted === null
      ? []
      : [...accepted.snapshot.spec.criteria, ...accepted.snapshot.spec.invariants].map((item) => item.id),
  )
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

function replayAcceptedRetirements(
  history: DecodedHistory,
  histories: readonly DecodedHistory[],
  replay: SpecIdentityReplay,
  uw: Scope,
  diagnostics: UwDiagnostic[],
  assessmentReplay?: AssessmentReplayContext,
): AcceptedOwnSpec[] {
  const authenticated: AcceptedOwnSpec[] = []
  const seen: ExternalRecordRef[] = []
  const controls = controlsOf(history).filter((record) => record.payload.control === 'accept-material')
  let replayMandateFound = false
  for (const mandate of mandatesOf(history)) {
    const isReplayMandate = replayForMandate(history, mandate, assessmentReplay)
    replayMandateFound ||= isReplayMandate
    const result = resolveAcceptedSpec(mandate, histories, assessmentReplay)
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

function validateAcceptedIds(
  active: ReadonlySet<SpecItemId>,
  replay: SpecIdentityReplay,
  uw: Scope,
  diagnostics: UwDiagnostic[],
): void {
  for (const id of active) {
    if (!replay.allocations.has(id))
      diagnostics.push(diag(uw, 'spec-ledger-conflict', `Accepted identity ${id} is unavailable`))
    if (replay.retired.has(id))
      diagnostics.push(diag(uw, 'spec-ledger-conflict', `Accepted identity ${id} was retired`))
  }
}

function referencedHistoryScopes(
  uw: Scope,
  histories: readonly DecodedHistory[],
  authenticated: readonly AcceptedOwnSpec[],
): Scope[] {
  const refs: ExternalRecordRef[] = authenticated.flatMap((spec) => [...spec.sourceRefs])
  const scopes: Scope[] = [uw, ...refs.map((ref) => ref.scope)]
  for (const history of histories) {
    if (!scopes.some((scope) => equalScope(scope, history.source.scope))) continue
    for (const operation of history.operations) {
      const record = operation.record
      if (
        record?.kind === 'action-receipt' &&
        record.payload.action === 'assess-spec' &&
        record.payload.phase === 'result' &&
        refs.some((ref) => sameRef(ref, { scope: history.source.scope, recordId: record.recordId, kind: record.kind }))
      )
        scopes.push(record.payload.start.scope)
    }
  }
  return scopes
}

function validateReferencedHistories(
  uw: Scope,
  histories: readonly DecodedHistory[],
  authenticated: readonly AcceptedOwnSpec[],
  diagnostics: UwDiagnostic[],
): void {
  const scopes = referencedHistoryScopes(uw, histories, authenticated)
  for (let i = 0; i < histories.length; i += 1) {
    const history = histories[i]
    if (history === undefined || !scopes.some((scope) => equalScope(scope, history.source.scope))) continue
    if (
      histories
        .slice(0, i)
        .some(
          (other) =>
            equalScope(other.source.scope, history.source.scope) && JSON.stringify(other) !== JSON.stringify(history),
        )
    )
      diagnostics.push(diag(uw, 'spec-ledger-conflict', 'Conflicting histories claim a referenced scope'))
  }
}

export function resolveSpecIdentityLedger(input: {
  uw: Scope
  history: DecodedHistory
  histories: readonly DecodedHistory[]
  accepted: AcceptedOwnSpec | null
  assessmentReplay?: AssessmentReplayContext
}): UwResult<SpecIdentityLedger> {
  const diagnostics: UwDiagnostic[] = []
  if (!equalScope(input.history.source.scope, input.uw))
    diagnostics.push(diag(input.uw, 'spec-ledger-incomplete', 'Identity history belongs to another UW'))
  const own = input.histories.find((history) => equalScope(history.source.scope, input.uw))
  if (own === undefined || JSON.stringify(own) !== JSON.stringify(input.history))
    diagnostics.push(diag(input.uw, 'spec-ledger-incomplete', 'Identity history does not match authentication context'))
  if (!input.history.source.complete)
    diagnostics.push(diag(input.uw, 'spec-ledger-incomplete', 'Identity history is incomplete'))
  const replay = replaySpecIdentityHistory(input.history, input.uw, diagnostics, input.histories)
  const active = acceptedIds(input.accepted)
  const authenticated = replayAcceptedRetirements(
    input.history,
    input.histories,
    replay,
    input.uw,
    diagnostics,
    input.assessmentReplay,
  )
  validateReferencedHistories(input.uw, input.histories, authenticated, diagnostics)
  if (input.accepted !== null && !authenticated.some((spec) => JSON.stringify(spec) === JSON.stringify(input.accepted)))
    diagnostics.push(diag(input.uw, 'spec-ledger-conflict', 'Current accepted Spec is not authenticated by history'))
  validateAcceptedIds(active, replay, input.uw, diagnostics)
  return diagnostics.length === 0
    ? {
        ok: true,
        value: {
          uw: input.uw,
          head: replay.head,
          nextCriterion: replay.nextCriterion,
          nextInvariant: replay.nextInvariant,
          allocations: replay.allocations,
          retired: replay.retired,
        },
      }
    : { ok: false, diagnostics }
}
export function prepareSpecAllocation(draft: SpecDraft, ledger: SpecIdentityLedger): UwResult<SpecAllocationPlan> {
  const parsed = specDraftSchema.safeParse(draft)
  return parsed.success
    ? buildSpecAllocationPlan(parsed.data, ledger)
    : { ok: false, diagnostics: [diag(ledger.uw, 'spec-invalid', 'Spec draft is invalid')] }
}

/** Plan new-member IDs without inventing a native issue or a durable identity. */
export function prepareNewSpecAllocation(draft: SpecDraft, repository: string): UwResult<SpecAllocationPlan> {
  const parsed = specDraftSchema.safeParse(draft)
  return parsed.success
    ? buildNewSpecAllocationPlan(parsed.data, repository)
    : {
        ok: false,
        diagnostics: [
          {
            code: 'spec-invalid',
            message: 'Spec draft is invalid',
            location: { kind: 'repository', repository },
            related: [],
          },
        ],
      }
}
