import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { FramingStage } from '../engine/framing-context-schema.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingSubmissionResult } from './feature-framing-contract.ts'
import {
  asUwDiagnostics,
  blockLease,
  type ControllerCore,
  currentAt,
  framingDiagnostic,
  type LeaseState,
  type RegisteredQuestion,
  submission,
} from './feature-framing-controller-lease.ts'
import { readIssueSource } from './feature-framing-controller-proposal.ts'
import { verifyFramingProcedures } from './feature-framing-procedures.ts'
import { validateFramingDecisionReferences } from './feature-framing-source.ts'
import { reservePreparedFramingProposal } from './uw-framing-prepare.ts'
export type SubmitActual = Readonly<{ ctx: ExtensionContext; toolCallId: string; signal: AbortSignal }>
export function refused(lease: LeaseState, code: string, message: string): FramingSubmissionResult {
  return submission(lease, 'refused', [framingDiagnostic(lease, code, message)])
}

export function stale(lease: LeaseState): FramingSubmissionResult {
  return refused(
    lease,
    'framing-supply-token-stale',
    'The framing lease changed during this submission; use the next projection',
  )
}

/** Assistant entries on the current branch that carry this lease's registered question tool calls. */
export function registeredQuestionEntries(lease: LeaseState, ctx: ExtensionContext): Map<string, RegisteredQuestion> {
  const byCall = new Map(lease.questions.map((question) => [question.toolCallId, question]))
  const entries = new Map<string, RegisteredQuestion>()
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'message' || entry.message.role !== 'assistant') continue
    for (const part of entry.message.content) {
      const question = part.type === 'toolCall' ? byCall.get(part.id) : undefined
      if (question) entries.set(entry.id, question)
    }
  }
  return entries
}
export function decisionProblem(
  lease: LeaseState,
  ctx: ExtensionContext,
  decisions: readonly { questionEntryId: string; answerEntryId: string }[],
  stage: FramingStage | null,
): UwDiagnostic | null {
  const entries = registeredQuestionEntries(lease, ctx)
  const valid = validateFramingDecisionReferences(ctx, decisions, new Set(entries.keys()))
  if (!valid.ok) return asUwDiagnostics(lease, valid.diagnostics)[0] ?? null
  if (
    stage !== null &&
    !decisions.some((item) => {
      const question = entries.get(item.questionEntryId)
      return question?.kind === 'question' && question.stage === stage
    })
  )
    return framingDiagnostic(
      lease,
      'framing-stage-decision-missing',
      `The ${stage} result needs a decision answering a question asked during ${stage}`,
    )
  return null
}

/**
 * Every accepted transition rechecks the exact supply and, for an issue source, the start basis.
 * Returns a refusal when the transition must not commit.
 */
export async function recheck(
  core: ControllerCore,
  lease: LeaseState,
  actual: SubmitActual,
  revision: number,
  rereadSource = true,
): Promise<FramingSubmissionResult | null> {
  const procedures = lease.procedures
  if (procedures === null) return refused(lease, 'framing-supply-unavailable', 'Framing supply is not loaded')
  const verified = await verifyFramingProcedures(procedures)
  if (!currentAt(core, lease, actual.ctx)) return stale(lease)
  if (!verified.ok) {
    blockLease(core, lease, 'framing-supply-changed', actual.ctx)
    return submission(lease, 'refused', asUwDiagnostics(lease, verified.diagnostics))
  }
  if (rereadSource && lease.source.kind === 'issue') {
    const fresh = await readIssueSource(core, lease, actual.ctx)
    if (!currentAt(core, lease, actual.ctx)) return stale(lease)
    if ('problem' in fresh || fresh.basis !== lease.sourceBasis) {
      blockLease(core, lease, 'framing-source-changed', actual.ctx)
      return submission(lease, 'refused', [
        'problem' in fresh
          ? fresh.problem
          : framingDiagnostic(lease, 'framing-source-changed', 'The selected issue changed since framing started'),
      ])
    }
  }
  if (lease.revision !== revision || actual.signal.aborted) return stale(lease)
  return null
}

export function reopen(lease: LeaseState, waitingQuestion: string | null): void {
  if (lease.proposal !== null) reservePreparedFramingProposal(lease.proposal.prepared)?.(false)
  lease.proposal = null
  lease.phase = { kind: 'interview', stage: lease.stage, waitingQuestion }
}
