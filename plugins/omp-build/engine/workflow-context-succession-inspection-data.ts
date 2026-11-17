import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { ContextNegativeInspection } from './workflow-context-negative-inspection.ts'
import { type MandateRef, matchingControls } from './workflow-context-succession-comparisons.ts'
import type { ContextSuccessionInspection } from './workflow-context-succession-inspection.ts'
import type { AcceptedSpecInspection } from './workflow-spec-authentication.ts'

export type SavedFrame = { histories: readonly DecodedHistory[]; inspection: ContextNegativeInspection }
export type ResolvedFrame = { histories: readonly DecodedHistory[]; inspection?: AcceptedSpecInspection }
export type InspectionBinding = {
  successor: MandateRef
  historiesDigest: string
  controlDigest: string
  starts: readonly string[]
  predecessor: MandateRef
  frame: SavedFrame
}
export type HistoricalState = {
  allowed: Set<string>
  active: Set<string>
  memo: Map<string, Result<ContextSuccessionInspection | undefined>>
  startsMemo: Map<string, ReadonlySet<string>>
  frames: Map<string, readonly DecodedHistory[]>
}
export type HistoricalCheckpoint = Record<'allowed' | 'memo' | 'startsMemo' | 'frames', ReadonlySet<string>>

export const inspectionFailure = (): Result<never> => ({
  ok: false,
  diagnostics: [diagnostic('unconfirmed', 'Context succession inspection is not authenticated')],
})

export function snapshotHistoricalObservation(
  histories: readonly DecodedHistory[],
): Result<{ histories: readonly DecodedHistory[]; digest: string }> {
  const snapshot = structuredClone(histories)
  const scopes = new Set<string>()
  for (const history of snapshot) {
    const key = `${history.source.scope.repository}\0${history.source.scope.target}`
    if (scopes.has(key) || !history.source.complete || history.source.diagnostics.length || history.diagnostics.length)
      return inspectionFailure()
    scopes.add(key)
  }
  return { ok: true, value: { histories: snapshot, digest: canonicalValueDigest(snapshot) } }
}

export function freezeInspectionData(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  for (const child of Object.values(value)) freezeInspectionData(child)
  Object.freeze(value)
}

export function initialHistoricalState(histories: readonly DecodedHistory[], digest: string): HistoricalState {
  return {
    allowed: new Set([digest]),
    active: new Set(),
    memo: new Map(),
    startsMemo: new Map(),
    frames: new Map([[digest, histories]]),
  }
}

export function checkpointHistoricalState(state: HistoricalState): HistoricalCheckpoint {
  return {
    allowed: new Set(state.allowed),
    memo: new Set(state.memo.keys()),
    startsMemo: new Set(state.startsMemo.keys()),
    frames: new Set(state.frames.keys()),
  }
}

export function makeInspectionBinding(
  successor: MandateRef,
  digest: string,
  control: unknown,
  starts: ReadonlySet<string>,
  predecessor: MandateRef,
  frame: SavedFrame,
): InspectionBinding {
  return {
    successor: structuredClone(successor),
    historiesDigest: digest,
    controlDigest: canonicalValueDigest(control),
    starts: [...starts],
    predecessor: structuredClone(predecessor),
    frame,
  }
}

export function bindingMatches(
  binding: InspectionBinding,
  digest: string,
  successor: MandateRef,
  control: unknown,
): boolean {
  return (
    sameRef(binding.successor, successor) &&
    binding.historiesDigest === digest &&
    binding.controlDigest === canonicalValueDigest(control)
  )
}

export function bindingSubject(
  binding: InspectionBinding,
  histories: readonly DecodedHistory[],
  digest: string,
): MandateRef | null {
  const controls = matchingControls(histories, binding.successor)
  if (
    controls === null ||
    controls.length !== 1 ||
    controls[0] === undefined ||
    !bindingMatches(binding, digest, binding.successor, controls[0])
  )
    return null
  return structuredClone(binding.successor)
}

export function attachSuccession(
  inspection: AcceptedSpecInspection | undefined,
  proof: ContextSuccessionInspection,
): AcceptedSpecInspection {
  return inspection?.kind === 'context-negative-inspection'
    ? { ...inspection, succession: proof }
    : { kind: 'selected-succession', succession: proof }
}
