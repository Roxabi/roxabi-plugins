import { expect } from 'vitest'
import { canonicalValueDigest } from '../canonical-value.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { MandateRef } from '../workflow-context-succession-comparisons.ts'
import {
  type ContextSuccessionInspection,
  contextSuccessionInspectionFrame,
  contextSuccessionInspectionStarts,
  contextSuccessionInspectionSubject,
  type HistoricalAcceptedSpecContext,
  historicalAcceptedSpecOwnedHistories,
} from '../workflow-context-succession-inspection.ts'
import { makeInspectionBinding, type SavedFrame } from '../workflow-context-succession-inspection-data.ts'
import { selectIncoming } from '../workflow-context-succession-inspection-phases.ts'
import { createContextSuccessionProofOwner } from '../workflow-context-succession-proof-owner.ts'
import type { MandateRecord } from '../workflow-control.ts'

export function assertForeignDigestIsolation(
  context: HistoricalAcceptedSpecContext,
  histories: readonly DecodedHistory[],
) {
  const altered = structuredClone(histories)
  const home = altered[0]
  if (!home) throw new Error('History unavailable for foreign registration')
  expect(home.source.complete).toBe(true)
  home.source.complete = false
  expect(canonicalValueDigest(altered)).not.toBe(canonicalValueDigest(histories))
  const foreign = createContextSuccessionProofOwner()
  const registered = foreign.registerHistories(altered, canonicalValueDigest(histories))
  expect(foreign.ownedDigest(registered)).toBe(canonicalValueDigest(histories))
  expect(historicalAcceptedSpecOwnedHistories(context, registered).ok).toBe(false)
}

export function assertForeignProofIsolation(
  histories: readonly DecodedHistory[],
  selected: MandateRecord,
  proof: ContextSuccessionInspection,
  successor: MandateRef,
  predecessor: MandateRef,
  savedFrame: SavedFrame,
) {
  const selection = selectIncoming(histories, selected)
  if (!selection.ok || !selection.value) throw new Error('Incoming succession unavailable')
  const starts = contextSuccessionInspectionStarts(proof, histories, successor)
  if (!starts.ok) throw new Error('Succession starts unavailable')
  const foreign = createContextSuccessionProofOwner()
  const forged = foreign.mint(
    makeInspectionBinding(
      successor,
      canonicalValueDigest(histories),
      selection.value.control,
      starts.value,
      predecessor,
      savedFrame,
    ),
  )
  expect(foreign.subject(forged, histories)).toEqual({ ok: true, value: successor })
  expect(foreign.starts(forged, histories, successor)).toEqual(starts)
  expect(foreign.frame(forged, histories, successor, predecessor)).toEqual({ ok: true, value: savedFrame })
  const untrusted = forged as unknown as ContextSuccessionInspection
  expect(contextSuccessionInspectionSubject(untrusted, histories).ok).toBe(false)
  expect(contextSuccessionInspectionStarts(untrusted, histories, successor).ok).toBe(false)
  expect(contextSuccessionInspectionFrame(untrusted, histories, successor, predecessor).ok).toBe(false)
}
