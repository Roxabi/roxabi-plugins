import type { Json, Payloads, Slot } from '../dist/contracts.js'
import type { NativeChildResult } from '../omp/review-runtime'

type ContributionContent = Payloads['contribution']['content']

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function jsonObject(value: Json): Record<string, Json> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function modelRaw(raw: Json): Json {
  const rawObject = jsonObject(raw)
  if (rawObject === null) return raw
  const terminal = jsonObject(rawObject.terminal ?? null)
  if (terminal === null || (!Object.hasOwn(terminal, 'task') && !Object.hasOwn(terminal, 'assignment'))) return raw
  const { task: _task, assignment: _assignment, ...modelTerminal } = terminal
  return { ...rawObject, terminal: modelTerminal }
}

/** Removes only SDK-echoed prompt envelopes from transient model input. */
export function modelContributionPayload(payload: Payloads['contribution']): Payloads['contribution'] {
  if (payload.native === null) return payload
  const raw = modelRaw(payload.native.raw)
  return raw === payload.native.raw ? payload : { ...payload, native: { ...payload.native, raw } }
}

function contentFor(slot: Slot | null, unknownContent: ContributionContent): ContributionContent {
  if (slot === null) return unknownContent
  switch (slot.output) {
    case 'decision':
      return 'decision'
    case 'action-result':
      return 'action-result'
    case 'findings':
    case 'spec':
      return 'findings'
  }
}

/**
 * Conserves every native submission before strict admission. A known slot records
 * the host-authorized expected binding; childId is only the observed native ID.
 * Unknown/duplicate native results retain null slot provenance rather than being
 * attributed to an expected worker.
 */
export function nativeContributionPayload(
  slot: Slot | null,
  child: NativeChildResult,
  inventoryId: string,
  contributionId: string,
  unknownContent: ContributionContent,
): Payloads['contribution'] {
  const content = contentFor(slot, unknownContent)
  let extracted = false
  let globalIndex = 0
  const originals = child.submissions.flatMap((submission) => {
    const report = object(submission.data)
    if (report === null || !Array.isArray(report.findings)) return []
    extracted = true
    return report.findings.map((data) => {
      const original = { id: `${contributionId}:f${globalIndex}`, attemptIndex: submission.attemptIndex, data }
      globalIndex += 1
      return original
    })
  })
  return {
    content,
    inventoryId,
    host: {
      origin: 'native',
      phase: slot?.phase ?? null,
      role: slot?.role ?? null,
      slotId: slot?.slotId ?? null,
      chunk: slot?.chunk ?? null,
      childId: child.id,
    },
    rawAttempts: child.submissions,
    native: {
      completion: child.usable ? 'completed' : 'incomplete',
      strict: child.usable ? 'valid' : child.structured === null ? 'absent' : 'invalid',
      raw: { terminal: child.raw, proofEvidence: child.proofEvidence },
    },
    structured: child.structured,
    findings: content === 'findings' && extracted ? originals : null,
  }
}
