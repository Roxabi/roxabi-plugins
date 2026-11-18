import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import { replayForMandate } from './uw-identity-replay.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import { resolveAcceptedSpecChain } from './workflow-accepted-spec-chain.ts'
import type { AcceptedOwnSpec, AcceptedSpecResult } from './workflow-accepted-spec-types.ts'
import {
  contextSuccessionInspectionFrame,
  type HistoricalAcceptedSpecContext,
  historicalAcceptedSpecFrame,
} from './workflow-context-succession-inspection.ts'
import {
  historyFor,
  type MandateRecord,
  mandateScope,
  mandatesOf,
  workflowOperationProblem,
} from './workflow-control.ts'
import type { SpecAssessment } from './workflow-output-schema.ts'
import { confirmedAccountedMandate } from './workflow-pr-binding.ts'
import { type AssessResultRecord, specChainFailure } from './workflow-spec-assessment.ts'
import {
  type AcceptedSpecInspection,
  type AssessmentReplayContext,
  confirmedAssessPairs,
} from './workflow-spec-authentication.ts'

type SpecChainFailure = Extract<AcceptedSpecResult, { ok: false }>
type Obligation = { record: AssessResultRecord; assessment: SpecAssessment }
export type StructuralOperands = {
  prefixes: readonly AcceptedOwnSpec[]
  obligations: readonly Obligation[]
}
export type Chain = StructuralOperands & { latest: AcceptedOwnSpec }
type CompatibilityStop = Obligation & { refusal: SpecChainFailure }
export type StoppedChain = StructuralOperands & { stop: CompatibilityStop }
type StructuralReplay =
  | ({ ok: true; spec: AcceptedOwnSpec } & StructuralOperands)
  | (SpecChainFailure & { stopped?: StoppedChain })

export function acceptedMandateKey(record: MandateRecord): string {
  return canonicalValueDigest({
    scope: mandateScope(record),
    recordId: record.recordId,
    operationId: record.operationId,
    record,
  })
}

export function assessmentOwnRefs(record: AssessResultRecord): OwnSpecRef[] {
  const exact = record.payload.exactInputs
  return [
    exact.accepted.ref,
    ...exact.accepted.inheritedOwnSpecRefs,
    ...exact.proposed.inheritedOwnSpecRefs,
    ...exact.childOwnSources.flatMap((entry) => (entry.own === null ? [] : [entry.own])),
  ]
}

function structuralReplay(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
  replayContext?: AssessmentReplayContext,
  inspection?: AcceptedSpecInspection,
  historical?: HistoricalAcceptedSpecContext,
): StructuralReplay {
  const scope = mandateScope(mandate)
  const home = historyFor(scope, histories)
  if (home === null || !home.source.complete) return specChainFailure('missing-history', 'Mandate history is missing')
  const problem = workflowOperationProblem(home)
  if (problem === 'ambiguous') return specChainFailure('ambiguous', 'Workflow history conflicts')
  if (problem === 'unconfirmed' || problem === 'incomplete')
    return specChainFailure('incomplete', 'Workflow history is not confirmed', problem)
  if (problem === 'incompatible-format')
    return specChainFailure('incomplete', 'Workflow history contains an incompatible authoritative format', problem)
  const mandateRef = { scope, recordId: mandate.recordId, kind: 'mandate' as const }
  const confirmed = confirmedAccountedMandate(home, mandateRef)
  if (confirmed === null)
    return specChainFailure('incomplete', 'Mandate is not a confirmed accounted record', 'unconfirmed')
  if (JSON.stringify(confirmed) !== JSON.stringify(mandate))
    return specChainFailure('ambiguous', 'Mandate does not match the authenticated history')
  if (
    confirmed.payload.ownSpec.uw.repository !== scope.repository ||
    confirmed.payload.ownSpec.uw.target !== scope.target
  )
    return specChainFailure('material-spec', 'Mandate own Spec does not belong to its mandate scope')
  const pairs = confirmedAssessPairs(home, histories, mandateRef, replayContext, inspection, historical)
  if (!pairs.ok) return pairs
  return recordedReplay({ confirmed, home, histories, mandateRef, scope })
}

function recordedReplay(
  input: Omit<Parameters<typeof resolveAcceptedSpecChain>[0], 'prefixes' | 'deferCompatibility'>,
): StructuralReplay {
  const prefixes: AcceptedOwnSpec[] = []
  const obligations: Obligation[] = []
  const trace: { stop?: CompatibilityStop } = {}
  const result = resolveAcceptedSpecChain({
    ...input,
    prefixes,
    deferCompatibility: (record, assessment, refusal) => {
      const obligation = { record, assessment }
      obligations.push(obligation)
      if (refusal !== undefined && trace.stop === undefined) trace.stop = { ...obligation, refusal }
    },
  })
  if (result.ok) return { ...result, prefixes, obligations }
  if (trace.stop !== undefined && trace.stop.refusal === result && prefixes.length > 0)
    return { ...result, stopped: { prefixes, obligations, stop: trace.stop } }
  return result
}

/** Observation-local structural closure; discovered operands are not yet accepted authority. */
export class AcceptedSpecDiscovery {
  readonly chains = new Map<string, Chain>()
  readonly failures = new Map<string, SpecChainFailure>()
  readonly stopped = new Map<string, StoppedChain>()
  private readonly queued = new Map<
    string,
    { mandate: MandateRecord; replayContext?: AssessmentReplayContext; inspection?: AcceptedSpecInspection }
  >()
  private readonly scannedScopes = new Set<string>()
  private successor: (ExternalRecordRef & { kind: 'mandate' }) | undefined

  constructor(
    private readonly histories: readonly DecodedHistory[],
    private readonly replayContext?: AssessmentReplayContext,
    private readonly inspection?: AcceptedSpecInspection,
    private readonly historical?: HistoricalAcceptedSpecContext,
  ) {}

  discover(mandate: MandateRecord, extra?: AssessResultRecord): void {
    if (this.inspection?.succession !== undefined)
      this.successor = { scope: mandateScope(mandate), kind: 'mandate', recordId: mandate.recordId }
    const home = historyFor(mandateScope(mandate), this.histories)
    this.queue(
      mandate,
      home !== null && replayForMandate(home, mandate, this.replayContext, this.inspection, this.histories)
        ? this.replayContext
        : undefined,
      this.inspection?.kind === 'selected-succession' ? this.inspection : this.inspectionFor(mandate),
    )
    if (extra !== undefined) for (const ref of assessmentOwnRefs(extra)) this.queueScope(ref)
    while (this.queued.size) {
      const first = this.queued.entries().next().value
      if (!first) break
      const [id, item] = first
      this.queued.delete(id)
      this.discoverChain(id, item)
    }
  }

  private inspectionFor(mandate: MandateRecord): AcceptedSpecInspection | undefined {
    const ref = this.inspection?.kind === 'context-negative-inspection' ? this.inspection.mandate : undefined
    return ref !== undefined &&
      ref.scope.repository === mandate.repository &&
      ref.scope.target === mandate.target &&
      ref.recordId === mandate.recordId
      ? this.inspection
      : undefined
  }

  private queue(record: MandateRecord, context?: AssessmentReplayContext, inspection?: AcceptedSpecInspection): void {
    const id = acceptedMandateKey(record)
    if (!this.queued.has(id) && !this.chains.has(id) && !this.failures.has(id))
      this.queued.set(id, { mandate: record, replayContext: context, inspection })
  }

  private queueScope(ref: OwnSpecRef): void {
    const scope = `${ref.uw.repository}\0${ref.uw.target}`
    if (this.scannedScopes.has(scope)) return
    this.scannedScopes.add(scope)
    const history = historyFor(ref.uw, this.histories)
    if (history !== null)
      for (const candidate of mandatesOf(history))
        this.queue(
          candidate,
          replayForMandate(history, candidate, this.replayContext, this.inspectionFor(candidate), this.histories)
            ? this.replayContext
            : undefined,
          this.inspectionFor(candidate),
        )
  }

  private discoverChain(
    id: string,
    item: { mandate: MandateRecord; replayContext?: AssessmentReplayContext; inspection?: AcceptedSpecInspection },
  ): void {
    let histories = this.histories
    let replay = item.replayContext
    let inspection = item.inspection
    if (this.historical !== undefined) {
      const frame = historicalAcceptedSpecFrame(this.historical, histories, item.mandate, inspection)
      if (!frame.ok) {
        this.failures.set(id, { ok: false, reason: 'incomplete', evidence: frame.diagnostics })
        return
      }
      histories = frame.value.histories
      inspection = frame.value.inspection
      const home = historyFor(mandateScope(item.mandate), histories)
      replay =
        home !== null && replayForMandate(home, item.mandate, this.replayContext, inspection, histories)
          ? this.replayContext
          : undefined
    }
    const successor = this.successor
    if (
      this.historical === undefined &&
      this.inspection?.succession !== undefined &&
      successor !== undefined &&
      successor.scope.repository === item.mandate.repository &&
      successor.scope.target === item.mandate.target &&
      successor.recordId !== item.mandate.recordId
    ) {
      const requested = { scope: mandateScope(item.mandate), kind: 'mandate' as const, recordId: item.mandate.recordId }
      const frame = contextSuccessionInspectionFrame(this.inspection.succession, this.histories, successor, requested)
      if (!frame.ok) {
        this.failures.set(id, { ok: false, reason: 'incomplete', evidence: frame.diagnostics })
        return
      }
      if (frame.value !== undefined) {
        histories = frame.value.histories
        replay = undefined
        inspection = frame.value.inspection
      }
    }
    const result = structuralReplay(item.mandate, histories, replay, inspection, this.historical)
    if (!result.ok) {
      this.failures.set(id, result)
      if (result.stopped !== undefined) {
        this.stopped.set(id, result.stopped)
        this.queueOperands(result.stopped)
      }
      return
    }
    const chain: Chain = { latest: result.spec, prefixes: result.prefixes, obligations: result.obligations }
    this.chains.set(id, chain)
    this.queueOperands(chain)
  }

  private queueOperands(chain: StructuralOperands): void {
    for (const prefix of chain.prefixes) for (const inherited of prefix.inheritedOwnSpecRefs) this.queueScope(inherited)
    for (const obligation of chain.obligations)
      for (const ref of assessmentOwnRefs(obligation.record)) this.queueScope(ref)
  }
}
