import { isDeepStrictEqual } from 'node:util'
import { json, nativeSnapshot, object } from './capture'
import type { Json, NativeChildResult, NativeProofBashCall, NativeProofDirective } from './contracts'
import type { ActiveBatch, ChildCapture } from './state'

type SelectedProofReference = { toolCallId: string; guardId: string | null }

function terminalStructured(value: Record<string, unknown>): Json | null {
  const output = value.structuredOutput
  return object(output) && output.status === 'valid' && json(output.data) ? output.data : null
}

function selectedProofReference(
  value: Json | null,
  directive: NativeProofDirective | null,
): SelectedProofReference | null {
  if (!object(value) || directive === null) return null
  if (directive.purpose !== 'fix-falsify') {
    return typeof value.proofToolCallId === 'string' && value.proofToolCallId.length > 0
      ? { toolCallId: value.proofToolCallId, guardId: null }
      : null
  }
  if (!Array.isArray(value.facts) || value.facts.length !== 1) return null
  const fact = value.facts[0]
  if (!object(fact) || typeof fact.guardId !== 'string') return null
  if (typeof fact.proofToolCallId !== 'string' || fact.proofToolCallId.length === 0) return null
  return { toolCallId: fact.proofToolCallId, guardId: fact.guardId }
}

function proofCallIds(structured: Record<string, unknown>): Set<string> {
  const ids = new Set<string>()
  if (typeof structured.proofToolCallId === 'string' && structured.proofToolCallId.length > 0) {
    ids.add(structured.proofToolCallId)
  }
  if (!Array.isArray(structured.commands)) return ids
  for (const command of structured.commands) {
    if (object(command) && typeof command.toolCallId === 'string' && command.toolCallId.length > 0) {
      ids.add(command.toolCallId)
    }
  }
  return ids
}

function referencedBashCalls(capture: ChildCapture | undefined, structured: Json | null): NativeProofBashCall[] {
  if (capture === undefined || !object(structured)) return []
  const selected: NativeProofBashCall[] = []
  for (const id of proofCallIds(structured)) {
    const completed = capture.completedBashCalls.get(id)
    if (completed !== undefined) selected.push(completed)
    for (const conflict of capture.conflictingBashCalls) {
      if (conflict.toolCallId === id) selected.push(conflict)
    }
  }
  return selected
}

function submissionReason(submissions: ChildCapture['submissions'], structured: Json | null): string | null {
  if (submissions.length === 0 || submissions.at(-1)?.data === null) return 'missing-captured-yield'
  return isDeepStrictEqual(structured, submissions.at(-1)?.data) ? null : 'structured-output-yield-mismatch'
}

function childCompletionReason(
  child: Record<string, unknown> | null,
  expectedId: string | null,
  structured: Json | null,
  submissions: ChildCapture['submissions'],
): string | null {
  if (child === null) return expectedId === null ? 'malformed-child-result' : 'missing-required-child-result'
  if (child.exitCode !== 0) return 'required-child-exit-code'
  if (child.error !== undefined && child.error !== null) return 'required-child-error'
  if (child.aborted === true) return 'required-child-aborted'
  if (!object(child.structuredOutput)) return 'missing-structured-output'
  if (child.structuredOutput.status !== 'valid') return 'structured-output-not-valid'
  return submissionReason(submissions, structured)
}

function proofEvidence(
  directive: NativeProofDirective | null,
  reference: SelectedProofReference | null,
  capture: ChildCapture | undefined,
) {
  if (directive === null) return null
  return {
    ...directive,
    guardId: reference?.guardId ?? null,
    call:
      reference === null || capture?.ambiguousProofCallIds.has(reference.toolCallId)
        ? null
        : (capture?.completedProofCalls.get(reference.toolCallId) ?? null),
  }
}

export function captureChildResult(
  active: ActiveBatch,
  value: unknown,
  expectedId: string | null,
  captureId: string | null,
): NativeChildResult {
  const child = object(value) ? value : null
  const id = child !== null && typeof child.id === 'string' ? child.id : null
  const captureKey = id ?? captureId
  const capture = captureKey === null ? undefined : active.captures.get(captureKey)
  const submissions = capture?.submissions ?? []
  const task =
    expectedId === null ? undefined : active.batch.tasks.tasks.find((candidate) => candidate.name === expectedId)
  const directive = task?.proofEvidence ?? null
  const structured = child === null ? null : terminalStructured(child)
  const proofReference = selectedProofReference(structured, directive)
  const reason = childCompletionReason(child, expectedId, structured, submissions)
  return {
    id,
    expectedId,
    submissions,
    proofEvidence: proofEvidence(directive, proofReference, capture),
    bashCalls: referencedBashCalls(capture, structured),
    raw: nativeSnapshot(value),
    partialText: capture?.partialText ?? null,
    structured,
    usable: reason === null,
    reason,
  }
}
