import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { Result } from './result.ts'
import { admitContextSuccession } from './workflow-context-succession.ts'
import type { MandateRef } from './workflow-context-succession-comparisons.ts'
import {
  attachSuccession,
  checkpointHistoricalState,
  inspectionFailure as fail,
  freezeInspectionData,
  type HistoricalCheckpoint,
  type HistoricalState,
  initialHistoricalState,
  makeInspectionBinding,
  type SavedFrame,
  snapshotHistoricalObservation,
} from './workflow-context-succession-inspection-data.ts'
import {
  bindSavedPredecessor,
  type IncomingSelection,
  qualifyCapturedNegative,
  reconstructIncomingPrefix,
  selectIncoming,
  selectOutgoing,
  selectPriorLink,
  type TraversalEdge,
  validateCapturedCut,
} from './workflow-context-succession-inspection-phases.ts'
import {
  type ContextSuccessionInspection,
  createContextSuccessionProofOwner,
} from './workflow-context-succession-proof-owner.ts'

export type { ContextSuccessionInspection } from './workflow-context-succession-proof-owner.ts'

import { type MandateRecord, mandateScope } from './workflow-control.ts'
import type { WorkflowEvidence } from './workflow-plan.ts'
import type { AcceptedSpecInspection } from './workflow-spec-authentication.ts'

declare const historicalContextBrand: unique symbol
export type HistoricalAcceptedSpecContext = { readonly [historicalContextBrand]: true }
const proofOwner = createContextSuccessionProofOwner()
const contextSuccessionInspectionStarts = proofOwner.starts
const contextSuccessionInspectionSubject = proofOwner.subject
const contextSuccessionInspectionFrame = proofOwner.frame

export { contextSuccessionInspectionFrame, contextSuccessionInspectionStarts, contextSuccessionInspectionSubject }

const historicalContexts = new WeakMap<object, HistoricalState>()

/** A read context is scoped to one complete, uniquely indexed observation. */
export function createHistoricalAcceptedSpecContext(
  histories: readonly DecodedHistory[],
): Result<HistoricalAcceptedSpecContext> {
  const snapshot = snapshotHistoricalObservation(histories)
  if (!snapshot.ok) return snapshot
  const context = Object.freeze({}) as HistoricalAcceptedSpecContext
  const { digest } = snapshot.value
  const owned = proofOwner.registerHistories(snapshot.value.histories, digest)
  historicalContexts.set(context, initialHistoricalState(owned, digest))
  return { ok: true, value: context }
}
/** Validate an external observation before using the context's immutable historical snapshot. */
export function historicalAcceptedSpecOwnedHistories(
  context: HistoricalAcceptedSpecContext,
  histories: readonly DecodedHistory[],
): Result<readonly DecodedHistory[]> {
  const state = historicalContexts.get(context)
  if (state === undefined) return fail()
  const digest = proofOwner.ownedDigest(histories) ?? canonicalValueDigest(structuredClone(histories))
  const owned = state.frames.get(digest)
  return owned !== undefined && state.allowed.has(digest) ? { ok: true, value: owned } : fail()
}

/** Bind only an authenticated observation to the immutable frame owned by this context. */
function authenticatedHistoricalFrame(
  context: HistoricalAcceptedSpecContext,
  histories: readonly DecodedHistory[],
): Result<{ state: HistoricalState; histories: readonly DecodedHistory[]; digest: string }> {
  const state = historicalContexts.get(context)
  if (state === undefined) return fail()
  const digest = proofOwner.ownedDigest(histories) ?? canonicalValueDigest(structuredClone(histories))
  const owned = state.frames.get(digest)
  if (!state.allowed.has(digest) || owned === undefined) return fail()
  return { ok: true, value: { state, histories: owned, digest } }
}

function incomingInspection(
  context: HistoricalAcceptedSpecContext,
  histories: readonly DecodedHistory[],
  mandate: MandateRecord,
  digest = proofOwner.digest(histories),
): Result<ContextSuccessionInspection | undefined> {
  const state = historicalContexts.get(context)
  if (state === undefined || !state.allowed.has(digest)) return fail()
  const selected = selectIncoming(histories, mandate)
  if (!selected.ok) return selected
  if (selected.value === undefined) return { ok: true, value: undefined }
  const selection = selected.value
  const { control } = selection
  const key = `${digest}\0${control.repository}\0${control.target}\0${control.recordId}`
  const cached = state.memo.get(key)
  if (cached !== undefined) return cached
  if (state.active.has(key)) return fail()
  const prefix = reconstructIncomingPrefix(histories, selection)
  if (!prefix.ok) return prefix
  const captured = state.frames.get(digest) === histories ? prefix.value : structuredClone(prefix.value)
  const cut = validateCapturedCut(captured, histories, selection, mandate)
  if (!cut.ok) return cut
  const cutDigest = proofOwner.digest(captured)
  const checkpoint = checkpointHistoricalState(state)
  if (!state.frames.has(cutDigest)) state.frames.set(cutDigest, proofOwner.registerHistories(captured, cutDigest))
  state.allowed.add(cutDigest)
  state.active.add(key)
  try {
    const result = authenticateIncomingProof(context, histories, mandate, captured, selection, state, cutDigest)
    if (!result.ok) return result
    state.memo.set(key, result)
    return result
  } finally {
    state.active.delete(key)
    if (!state.memo.has(key)) rollbackHistoricalState(state, checkpoint)
  }
}

function authenticateIncomingProof(
  context: HistoricalAcceptedSpecContext,
  histories: readonly DecodedHistory[],
  mandate: MandateRecord,
  captured: readonly DecodedHistory[],
  selection: IncomingSelection,
  state: HistoricalState,
  cutDigest: string,
): Result<ContextSuccessionInspection | undefined> {
  const admitted = admitContextSuccession(selection.control, histories, context)
  if (!admitted.ok) return admitted
  const qualified = qualifyCapturedNegative(admitted.value, mandate, captured, selection)
  if (!qualified.ok) return qualified
  const savedHistories = state.frames.get(cutDigest)
  if (savedHistories === undefined) return fail()
  const savedFrame = { histories: savedHistories, inspection: structuredClone(qualified.value.inspection) }
  freezeInspectionData(savedFrame)
  return {
    ok: true,
    value: proofOwner.mint(
      makeInspectionBinding(
        selection.successor,
        proofOwner.digest(histories),
        selection.control,
        admitted.value.disposedStartKeys,
        qualified.value.predecessor,
        savedFrame,
      ),
    ),
  }
}

function rollbackHistoricalState(state: HistoricalState, checkpoint: HistoricalCheckpoint): void {
  for (const key of state.allowed) if (!checkpoint.allowed.has(key)) state.allowed.delete(key)
  for (const key of state.memo.keys()) if (!checkpoint.memo.has(key)) state.memo.delete(key)
  for (const key of state.startsMemo.keys()) if (!checkpoint.startsMemo.has(key)) state.startsMemo.delete(key)
  for (const key of state.frames.keys()) if (!checkpoint.frames.has(key)) state.frames.delete(key)
}

function frameForTraversal(
  state: HistoricalState,
  histories: readonly DecodedHistory[],
  digest: string,
  proof: ContextSuccessionInspection,
  edge: TraversalEdge,
): Result<SavedFrame> {
  if (state.frames.get(digest) === histories) return proofOwner.borrowFrame(proof, histories, edge)
  const frame = contextSuccessionInspectionFrame(proof, histories, edge.successor, edge.requested)
  if (!frame.ok) return frame
  return frame.value === undefined ? fail() : { ok: true, value: frame.value }
}

/** Seal the historical saved-cut proof for this exact selected successor and observation. */
export function prepareContextSuccessionInspection(
  evidence: WorkflowEvidence,
  mandate: MandateRecord,
): Result<ContextSuccessionInspection | undefined> {
  const context = createHistoricalAcceptedSpecContext(evidence.causal.histories)
  if (!context.ok) return context
  const owned = historicalAcceptedSpecOwnedHistories(context.value, evidence.causal.histories)
  return owned.ok ? incomingInspection(context.value, owned.value, mandate) : owned
}

/** Resolve the requested mandate in its authenticated saved frame, never an execution permission. */
export function historicalAcceptedSpecFrame(
  context: HistoricalAcceptedSpecContext,
  histories: readonly DecodedHistory[],
  mandate: MandateRecord,
  inspection?: AcceptedSpecInspection,
): Result<{ histories: readonly DecodedHistory[]; inspection?: AcceptedSpecInspection }> {
  const authenticated = authenticatedHistoricalFrame(context, histories)
  if (!authenticated.ok) return authenticated
  const { state, digest } = authenticated.value
  histories = authenticated.value.histories
  const outgoing = selectOutgoing(histories, mandate)
  if (!outgoing.ok) return outgoing
  if (outgoing.value !== undefined) {
    const proof = incomingInspection(context, histories, outgoing.value.mandate, digest)
    if (!proof.ok || proof.value === undefined) return proof.ok ? fail() : proof
    const frame = frameForTraversal(state, histories, digest, proof.value, outgoing.value)
    if (!frame.ok) return frame
    return historicalAcceptedSpecFrame(context, frame.value.histories, mandate, frame.value.inspection)
  }
  const incoming = incomingInspection(context, histories, mandate, digest)
  if (!incoming.ok) return incoming
  if (incoming.value === undefined) return { ok: true, value: { histories, inspection } }
  return { ok: true, value: { histories, inspection: attachSuccession(inspection, incoming.value) } }
}

/** Historical exact STARTs along this mandate's authenticated incoming same-UW lineage. */
export function historicalAcceptedSpecPriorStarts(
  context: HistoricalAcceptedSpecContext,
  histories: readonly DecodedHistory[],
  mandate: MandateRecord,
): Result<ReadonlySet<string>> {
  const authenticated = authenticatedHistoricalFrame(context, histories)
  if (!authenticated.ok) return authenticated
  const { state, digest } = authenticated.value
  histories = authenticated.value.histories
  const key = `starts\0${digest}\0${canonicalValueDigest(mandate)}`
  const cached = state.startsMemo.get(key)
  if (cached !== undefined) return { ok: true, value: new Set(cached) }
  if (state.active.has(key)) return fail()
  state.active.add(key)
  try {
    const proof = incomingInspection(context, histories, mandate, digest)
    if (!proof.ok) return proof
    if (proof.value === undefined) {
      state.startsMemo.set(key, new Set())
      return { ok: true, value: new Set() }
    }
    const ref: MandateRef = { scope: mandateScope(mandate), kind: 'mandate', recordId: mandate.recordId }
    const edge = selectPriorLink(histories, ref)
    if (!edge.ok) return edge
    const starts = contextSuccessionInspectionStarts(proof.value, histories, ref)
    if (!starts.ok) return starts
    const saved = frameForTraversal(state, histories, digest, proof.value, edge.value)
    if (!saved.ok) return saved
    const predecessor = bindSavedPredecessor(saved.value.histories, edge.value.requested)
    if (!predecessor.ok) return predecessor
    const prior = historicalAcceptedSpecPriorStarts(context, saved.value.histories, predecessor.value)
    if (!prior.ok) return prior
    const result = new Set([...prior.value, ...starts.value])
    state.startsMemo.set(key, result)
    return { ok: true, value: new Set(result) }
  } finally {
    state.active.delete(key)
  }
}
