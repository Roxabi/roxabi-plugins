import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import type { FramingForm } from '../engine/framing-form-schema.ts'
import type { FramingSubmissionResult } from './feature-framing-contract.ts'
import {
  decisionProblem,
  recheck,
  refused,
  registeredQuestionEntries,
  reopen,
  type SubmitActual,
  stale,
} from './feature-framing-controller-form-gate.ts'
import { advance, retainDetail, retainIndex } from './feature-framing-controller-index.ts'
import {
  asUwDiagnostics,
  blockLease,
  type ControllerCore,
  closeLease,
  currentAt,
  framingDiagnostic,
  type LeaseState,
  submission,
} from './feature-framing-controller-lease.ts'
import { prepareProposal } from './feature-framing-controller-proposal.ts'
import { selectExisting } from './feature-framing-controller-select.ts'
import { stageResult } from './feature-framing-controller-stage.ts'
import { captureFramingMaterial, framingUserEntry } from './feature-framing-source.ts'

/** The latest registered question is answered only by a later genuine operator USER entry. */
function answerState(lease: LeaseState, ctx: ExtensionContext): 'none' | 'waiting' | 'answered' {
  const last = lease.questions.at(-1)
  if (lease.phase.kind !== 'interview' || lease.phase.waitingQuestion === null || !last) return 'none'
  const branch = ctx.sessionManager.getBranch()
  const index = branch.findIndex(
    (entry) =>
      entry.type === 'message' &&
      entry.message.role === 'assistant' &&
      entry.message.content.some((part) => part.type === 'toolCall' && part.id === last.toolCallId),
  )
  if (index < 0) return 'waiting'
  for (const entry of branch.slice(index + 1)) {
    const answer = framingUserEntry(ctx, entry.id)
    if (answer.ok && answer.value.trim() !== '') return 'answered'
  }
  return 'waiting'
}

async function registerQuestion(
  core: ControllerCore,
  lease: LeaseState,
  form: Extract<FramingForm, { kind: 'question' | 'wayfinder-offer' }>,
  actual: SubmitActual,
): Promise<FramingSubmissionResult> {
  if (lease.questions.some((item) => item.toolCallId === actual.toolCallId))
    return refused(lease, 'framing-question-duplicate', 'This tool call already registered a question')
  const blocked = await recheck(core, lease, actual, lease.revision)
  if (blocked) return blocked
  lease.questions.push(
    Object.freeze({
      toolCallId: actual.toolCallId,
      question: form.question,
      stage: lease.stage,
      kind: form.kind === 'question' ? 'question' : 'wayfinder-offer',
    }),
  )
  reopen(lease, form.question)
  advance(lease, actual.ctx)
  return submission(lease, 'waiting', [
    framingDiagnostic(
      lease,
      'framing-question-registered',
      'Ask the operator exactly this question in your reply, then end your turn. Framing waits for a genuine operator answer.',
    ),
  ])
}

async function captureMaterial(
  core: ControllerCore,
  lease: LeaseState,
  form: Extract<FramingForm, { kind: 'material' }>,
  actual: SubmitActual,
): Promise<FramingSubmissionResult> {
  const id = `m${lease.nextMaterial}`
  const captured = captureFramingMaterial(actual.ctx, id, form.producer, form.entry)
  if (!captured.ok) return submission(lease, 'refused', asUwDiagnostics(lease, captured.diagnostics))
  const blocked = await recheck(core, lease, actual, lease.revision)
  if (blocked) return blocked
  lease.nextMaterial += 1
  lease.materials = [...lease.materials.filter((item) => item.origin.entryId !== form.entry), captured.value]
  reopen(lease, null)
  advance(lease, actual.ctx)
  return submission(lease, 'accepted', [
    framingDiagnostic(
      lease,
      'framing-material-captured',
      `Captured ${id} (${form.producer}) from operator entry ${form.entry}; account for every source span in the proposal.`,
    ),
  ])
}

function answerOnly(core: ControllerCore, lease: LeaseState): FramingSubmissionResult {
  lease.revision += 1
  closeLease(
    core,
    lease,
    { kind: 'closed', reason: 'answer-only' },
    undefined,
    'feature-framing: pas d’UW — answered without any UW, relation, checkout or bootstrap effect',
  )
  return submission(lease, 'accepted', [
    framingDiagnostic(
      lease,
      'framing-answer-only',
      'Reply with the answer and state “pas d’UW”. No UW, relation, checkout or bootstrap effect happens.',
    ),
  ])
}

async function stageProposal(
  core: ControllerCore,
  lease: LeaseState,
  form: Extract<FramingForm, { kind: 'proposal' }>,
  actual: SubmitActual,
): Promise<FramingSubmissionResult> {
  const decisions = decisionProblem(lease, actual.ctx, form.decisions, null)
  if (decisions) return submission(lease, 'refused', [decisions])
  if (form.aggregate.kind === 'wayfinder') {
    const entries = registeredQuestionEntries(lease, actual.ctx)
    if (!form.decisions.some((item) => entries.get(item.questionEntryId)?.kind === 'wayfinder-offer'))
      return refused(
        lease,
        'framing-wayfinder-choice-missing',
        'A Wayfinder proposal needs the operator’s answer to a registered Wayfinder offer',
      )
  }
  const revision = lease.revision
  const blocked = await recheck(core, lease, actual, revision, false)
  if (blocked) return blocked
  const staged = await prepareProposal(core, lease, form, actual.ctx)
  if (!currentAt(core, lease, actual.ctx) || lease.revision !== revision || actual.signal.aborted) return stale(lease)
  if ('problem' in staged) {
    if (staged.problem.code === 'framing-source-changed') blockLease(core, lease, 'framing-source-changed', actual.ctx)
    return submission(lease, 'refused', [staged.problem])
  }
  if (!staged.prepared.ok) return submission(lease, 'refused', staged.prepared.diagnostics)
  const prepared = staged.prepared.value
  lease.proposal = Object.freeze({ prepared, revision: staged.revision })
  lease.phase = { kind: 'proposal-ready', digest: prepared.digest }
  lease.revision = staged.revision
  lease.token = null
  retainDetail(lease, actual.ctx, {
    format: 'omp-build-framing-proposal-detail/1',
    digest: prepared.digest,
    proposal: prepared.proposal,
  })
  retainIndex(lease, actual.ctx)
  core.host.status(
    `feature-framing: proposal ${prepared.digest.slice(0, 12)} ready; the operator reviews and confirms it with the framing shortcut`,
  )
  return submission(lease, 'accepted', [
    framingDiagnostic(
      lease,
      'framing-proposal-staged',
      'The proposal is staged read-only. Only the operator can review and confirm it through the host framing shortcut; end your turn.',
    ),
  ])
}

/**
 * Applies one parsed form under an exact current token. Read-only: may stage a proposal,
 * never opens UI, writes, checks out, moves or delivers.
 */
export async function applyFramingForm(
  core: ControllerCore,
  lease: LeaseState,
  form: FramingForm,
  actual: SubmitActual,
): Promise<FramingSubmissionResult> {
  if (form.kind === 'question' || form.kind === 'wayfinder-offer') return registerQuestion(core, lease, form, actual)
  const answer = answerState(lease, actual.ctx)
  if (answer === 'waiting')
    return submission(lease, 'waiting', [
      framingDiagnostic(
        lease,
        'framing-answer-pending',
        'Framing waits for a genuine operator answer to the registered question',
      ),
    ])
  if (answer === 'answered' && lease.phase.kind === 'interview') lease.phase = { ...lease.phase, waitingQuestion: null }
  if (lease.phase.kind !== 'interview' && lease.phase.kind !== 'proposal-ready')
    return refused(lease, 'framing-phase', `Forms are not accepted in phase ${lease.phase.kind}`)
  switch (form.kind) {
    case 'grilling':
    case 'terminology':
    case 'module-design':
      return stageResult(core, lease, form, actual)
    case 'material':
      return captureMaterial(core, lease, form, actual)
    case 'select-existing':
      return selectExisting(core, lease, form, actual)
    case 'answer-only':
      return answerOnly(core, lease)
    case 'proposal':
      return stageProposal(core, lease, form, actual)
  }
}
