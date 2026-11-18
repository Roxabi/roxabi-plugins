import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { Result } from './result.ts'
import type { ContextNegativeInspection } from './workflow-context-negative-inspection.ts'
import { type MandateRef, matchingControls } from './workflow-context-succession-comparisons.ts'
import {
  bindingMatches,
  bindingSubject,
  inspectionFailure as fail,
  freezeInspectionData,
  type InspectionBinding,
  type SavedFrame,
} from './workflow-context-succession-inspection-data.ts'
import type { TraversalEdge } from './workflow-context-succession-inspection-phases.ts'

/** Each invocation owns its proof brand, token and immutable-history registry. */
export function createContextSuccessionProofOwner() {
  const ownedHistoryDigests = new WeakMap<object, string>()
  const token = Symbol('context-succession-inspection')
  function registerHistories(histories: readonly DecodedHistory[], digest: string): readonly DecodedHistory[] {
    freezeInspectionData(histories)
    ownedHistoryDigests.set(histories, digest)
    return histories
  }
  function ownedDigest(histories: readonly DecodedHistory[]): string | undefined {
    return ownedHistoryDigests.get(histories)
  }
  function digest(histories: readonly DecodedHistory[]): string {
    return ownedDigest(histories) ?? canonicalValueDigest(histories)
  }
  class Inspection {
    readonly #binding: InspectionBinding
    constructor(authority: symbol, binding: InspectionBinding) {
      if (authority !== token) throw new TypeError('Context succession inspections are engine-created')
      this.#binding = binding
      Object.freeze(this)
    }
    read(histories: readonly DecodedHistory[], successor: MandateRef, control: unknown): ReadonlySet<string> | null {
      const binding = this.#binding
      return bindingMatches(binding, digest(histories), successor, control) ? new Set(binding.starts) : null
    }
    subject(histories: readonly DecodedHistory[]): MandateRef | null {
      const binding = this.#binding
      return bindingSubject(binding, histories, digest(histories))
    }
    frame(
      histories: readonly DecodedHistory[],
      successor: MandateRef,
      control: unknown,
      requested: MandateRef,
      authority?: symbol,
    ): SavedFrame | null | undefined {
      if (Inspection.prototype.read.call(this, histories, successor, control) === null) return null
      return sameRef(this.#binding.predecessor, requested)
        ? authority === token && ownedHistoryDigests.has(histories)
          ? this.#binding.frame
          : structuredClone(this.#binding.frame)
        : undefined
    }
  }
  Object.freeze(Inspection.prototype)
  function mint(binding: InspectionBinding): Inspection {
    return new Inspection(token, binding)
  }
  function contextSuccessionInspectionStarts(
    proof: Inspection | undefined,
    histories: readonly DecodedHistory[],
    successor: MandateRef,
  ): Result<ReadonlySet<string>> {
    if (proof === undefined) return { ok: true, value: new Set() }
    const controls = matchingControls(histories, successor)
    if (controls === null || controls.length !== 1 || controls[0] === undefined) return fail()
    try {
      const starts = Inspection.prototype.read.call(proof, histories, successor, controls[0])
      return starts === null ? fail() : { ok: true, value: starts }
    } catch {
      return fail()
    }
  }
  function contextSuccessionInspectionSubject(
    proof: Inspection,
    histories: readonly DecodedHistory[],
  ): Result<MandateRef> {
    try {
      const subject = Inspection.prototype.subject.call(proof, histories)
      return subject === null ? fail() : { ok: true, value: subject }
    } catch {
      return fail()
    }
  }
  function contextSuccessionInspectionFrame(
    proof: Inspection | undefined,
    histories: readonly DecodedHistory[],
    successor: MandateRef,
    requested: MandateRef,
  ): Result<{ histories: readonly DecodedHistory[]; inspection: ContextNegativeInspection } | undefined> {
    if (proof === undefined) return { ok: true, value: undefined }
    const controls = matchingControls(histories, successor)
    if (controls === null || controls.length !== 1 || controls[0] === undefined) return fail()
    try {
      const frame = Inspection.prototype.frame.call(proof, histories, successor, controls[0], requested)
      return frame === null ? fail() : { ok: true, value: frame }
    } catch {
      return fail()
    }
  }
  function borrowFrame(
    proof: Inspection,
    histories: readonly DecodedHistory[],
    edge: TraversalEdge,
  ): Result<SavedFrame> {
    const frame = Inspection.prototype.frame.call(proof, histories, edge.successor, edge.control, edge.requested, token)
    return frame === null || frame === undefined ? fail() : { ok: true, value: frame }
  }
  return Object.freeze({
    registerHistories,
    ownedDigest,
    digest,
    mint,
    starts: contextSuccessionInspectionStarts,
    subject: contextSuccessionInspectionSubject,
    frame: contextSuccessionInspectionFrame,
    borrowFrame,
  })
}

export type ContextSuccessionInspection = ReturnType<ReturnType<typeof createContextSuccessionProofOwner>['mint']>
