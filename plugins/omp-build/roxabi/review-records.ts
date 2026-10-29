import {
  buildRecord,
  type CanonicalRecord,
  type Kind,
  type Payloads,
  type RecordDraft,
  type Result,
  type Scope,
  type Slot,
} from '../dist/contracts.js'
import type { NativeTask } from '../omp/review-runtime/contracts'
import type { PreparedReviewBatch, ReviewContext, ReviewStage } from './review-contract'
import type { ObservedEvidence } from './review-input-contract'
import type { ReviewPanel } from './review-panel'

export type ReviewIdentity = {
  runId: string
  operationId: string
  next(kind: string): string
}
export type ReviewSlot = Slot

export function createReviewIdentity(context: Pick<ReviewContext, 'runId' | 'operationId'>): ReviewIdentity {
  let sequence = 0
  return {
    runId: context.runId,
    operationId: context.operationId,
    next(kind) {
      sequence += 1
      return `${context.runId}-${kind}-${sequence}`
    },
  }
}

export function candidateSource(input: {
  context: ReviewContext & { number: number }
  pr: { base: string; baseGitSHA: string }
  chunks: readonly {
    index: number
    diff: string
    digest: string
    files: readonly { path: string; text: string | null; deleted: boolean; binary?: boolean }[]
  }[]
}): string {
  const subject =
    input.context.subject.kind === 'epic-range'
      ? `Epic range subject: ${input.context.subject.range}`
      : `Pull-request subject on base ${input.pr.base}`
  return [
    `Review target: ${input.context.repository}#${input.context.number}`,
    subject,
    `Candidate head: ${input.context.candidateGitSHA}`,
    `Base branch: ${input.pr.base}`,
    `Base commit: ${input.pr.baseGitSHA}`,
    'Complete candidate chunk material:',
    ...input.chunks.map((chunk) =>
      [
        `Chunk ${chunk.index} full diff:\n${chunk.diff}`,
        `Chunk ${chunk.index} digest:\n${chunk.digest}`,
        `Chunk ${chunk.index} candidate files:\n${chunk.files
          .map(
            (file) =>
              `${file.deleted ? 'deleted' : file.binary ? 'binary' : 'present'} ${file.path}\n${file.text ?? ''}`,
          )
          .join('\n\n')}`,
      ].join('\n\n'),
    ),
  ].join('\n\n')
}

export function observedEvidenceContext(_evidence: ObservedEvidence): string {
  return 'omp-build review action. Read only the procedure and the index named on each task.'
}

export function slotsForInitial(specTask: NativeTask, panel: ReviewPanel): ReviewSlot[] {
  const spec: ReviewSlot = {
    slotId: specTask.name,
    phase: 'spec',
    role: 'R-review-spec',
    chunk: null,
    required: true,
    output: 'spec',
    classId: null,
    sourceFindingIds: [],
  }
  const panelSlots = panel.tasks.map((task) => {
    const match = /^panel-(\d+)-(.+)$/.exec(task.name)
    if (!match) throw new Error(`panel task has no canonical slot name: ${task.name}`)
    return {
      slotId: task.name,
      phase: 'panel' as const,
      role: match[2],
      chunk: Number(match[1]),
      required: true,
      output: 'findings' as const,
      classId: null,
      sourceFindingIds: [],
    }
  })
  return [spec, ...panelSlots]
}

export function recordBase(identity: ReviewIdentity, scope: Scope, recordId: string) {
  return {
    version: 1 as const,
    recordId,
    runId: identity.runId,
    operationId: `${identity.operationId}-${identity.next('op')}`,
    repository: scope.repository,
    target: scope.target,
  }
}

export function requireRecord<K extends Kind>(
  result: Result<Extract<CanonicalRecord, { kind: K }>>,
  kind: K,
): Extract<CanonicalRecord, { kind: K }> {
  if (!result.ok) {
    throw new Error(`canonical ${kind} rejected: ${result.diagnostics.map((item) => item.code).join(',')}`)
  }
  return result.value
}

export function createInventory(input: {
  identity: ReviewIdentity
  scope: Scope
  stage: ReviewStage
  slots: ReviewSlot[]
  tasks: NativeTask[]
  payload: Payloads['review-attempt']
  observedEvidence: ObservedEvidence
  knownSlots: Map<string, ReviewSlot>
}): PreparedReviewBatch {
  const recordId = input.identity.next('review-attempt')
  const inheritedRoot = input.payload.rootAttemptId
  if (input.stage !== 'initial' && typeof inheritedRoot !== 'string') {
    throw new Error('inventory-root-missing')
  }
  const rootAttemptId = input.stage === 'initial' ? recordId : inheritedRoot
  const inventory = requireRecord(
    buildRecord({
      ...recordBase(input.identity, input.scope, recordId),
      kind: 'review-attempt',
      payload: { ...input.payload, rootAttemptId },
    } satisfies Extract<RecordDraft, { kind: 'review-attempt' }>),
    'review-attempt',
  )
  for (const slot of input.slots) input.knownSlots.set(slot.slotId, slot)
  return {
    stage: input.stage,
    rootAttemptId,
    inventory,
    batch: {
      operationId: inventory.operationId,
      tasks: {
        context: observedEvidenceContext(input.observedEvidence),
        tasks: input.tasks,
      },
    },
  }
}
