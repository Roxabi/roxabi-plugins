import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { Result } from '../engine/result.ts'
import { issueReference } from './feature-selection.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'

/** Only a single text USER entry from the current branch can carry operator material. */
export function framingUserEntry(ctx: ExtensionContext, entryId: string): Result<string> {
  const entry = ctx.sessionManager.getBranch().find((item) => item.id === entryId)
  if (entry?.type !== 'message' || entry.message.role !== 'user')
    return actionFailure('framing-material-entry-shape', 'Expected a USER entry on the current session branch')
  if (entry.message.attribution === 'agent' || entry.message.synthetic === true)
    return actionFailure('framing-material-entry-shape', 'Expected an operator-authored USER entry')
  const content = entry.message.content
  if (typeof content === 'string') return { ok: true, value: content }
  if (content.length !== 1 || content[0]?.type !== 'text')
    return actionFailure('framing-material-entry-shape', 'Expected a single text USER entry')
  return { ok: true, value: content[0].text }
}

/** The token is chosen by the operator text, never by a model-supplied Scope. */
export function framingReferenceInText(text: string, reference: string): boolean {
  if (reference !== reference.trim() || /^\d+$/.test(reference) || !issueReference(reference)) return false
  let offset = text.indexOf(reference)
  while (offset !== -1) {
    const before = offset === 0 ? '' : text[offset - 1]
    const end = offset + reference.length
    const after = end === text.length ? '' : text[end]
    if ((before === '' || /[\s(]/.test(before)) && (after === '' || /[\s.,;:!?)]/.test(after))) return true
    offset = text.indexOf(reference, offset + 1)
  }
  return false
}
/** A model-proposed decision can cite only a registered question followed by a genuine USER answer. */
export function validateFramingDecisionReferences(
  ctx: ExtensionContext,
  decisions: readonly { questionEntryId: string; answerEntryId: string }[],
  registeredQuestions: ReadonlySet<string>,
): Result<true> {
  const branch = ctx.sessionManager.getBranch()
  for (const decision of decisions) {
    const questionIndex = branch.findIndex((entry) => entry.id === decision.questionEntryId)
    const answerIndex = branch.findIndex((entry) => entry.id === decision.answerEntryId)
    const question = branch[questionIndex]
    if (
      !registeredQuestions.has(decision.questionEntryId) ||
      question?.type !== 'message' ||
      question.message.role !== 'assistant' ||
      answerIndex <= questionIndex ||
      questionIndex < 0
    ) {
      return actionFailure(
        'framing-decision-reference-invalid',
        'Decision must reference a registered question and a later USER answer',
      )
    }
    const answer = framingUserEntry(ctx, decision.answerEntryId)
    if (!answer.ok) return answer
    if (answer.value.trim() === '')
      return actionFailure('framing-decision-reference-invalid', 'Decision answer must not be empty')
  }
  return { ok: true, value: true }
}

export function captureFramingMaterial(
  ctx: ExtensionContext,
  id: string,
  producer: 'to-spec' | 'to-tickets',
  entryId: string,
) {
  if (!/^m[1-9][0-9]*$/.test(id))
    return actionFailure('framing-material-id-invalid', 'Material identity must be host allocated')
  const entry = framingUserEntry(ctx, entryId)
  if (!entry.ok) return entry
  const sessionId = ctx.sessionManager.getSessionId()
  const body = entry.value
  return {
    ok: true as const,
    value: Object.freeze({
      id,
      producer,
      origin: Object.freeze({ kind: 'operator-entry' as const, sessionId, entryId }),
      raw: Object.freeze({
        reference: `omp-session-entry:${sessionId}/${entryId}`,
        body,
        bodySha256: sha256Bytes(Buffer.from(body, 'utf8')),
        lastEditedAt: null,
      }),
    }),
  }
}
