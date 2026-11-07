import type { threeDeliveredChildren } from '../../../../engine/__tests__/uw-delivery-proof-fixture.ts'
import type { ActionInputs, RecordInputRef } from '../../../../engine/action-input-schema.ts'
import type { DecodedHistory } from '../../../../engine/history-schema.ts'
import { buildRecord } from '../../../../engine/record-construction.ts'
import { validateFreshDecision } from '../../../../engine/review-fresh-decision.ts'
import { scopeKey } from '../../../../engine/uw-graph.ts'
import { recordsOf } from '../../../../engine/workflow-control.ts'
import type { UwRead } from '../../../../roxabi/uw-contract.ts'
import { encodeCriterionRecords } from '../../../../testing/criterion-approval.ts'
import { criterionDispositionRecords } from '../../../../testing/criterion-dispositions.ts'
import { criterionEpicReviewGraph } from '../../../../testing/criterion-range-approval.ts'
import type { produceParentIntegration } from '../../../../testing/parent-integration-producer.ts'
import { submission } from '../../../../testing/record-builders.ts'

type World = Parameters<Parameters<typeof threeDeliveredChildren>[3]>[0]
type Produced = Awaited<ReturnType<typeof produceParentIntegration>>

/** Publish an independently admitted blocking review on the current parent history. */
export async function blockingSelectorProof({
  world,
  beforeReview,
  installed,
  code,
  cwd,
  current,
  history,
  metadata,
  childRefs,
  inputs,
  external,
}: {
  world: World
  beforeReview: Produced['beforeReview']
  installed: Produced['installed']
  code: Produced['code']
  cwd: string
  current: UwRead
  history: DecodedHistory
  metadata: RecordInputRef[]
  childRefs: RecordInputRef[]
  inputs: ActionInputs
  external: DecodedHistory[]
}) {
  const projection = { catalogues: beforeReview.catalogues, acceptedPolicy: null }
  const blocked = criterionEpicReviewGraph({
    mandate: world.parent,
    inputs,
    head: code.head,
    range: code.base + '..' + code.head,
    issueRecords: recordsOf(history),
    coverageReferences: [...metadata, ...childRefs],
    prefix: 'selector-blocking',
    blocking: true,
  })
  const { blockingDecision, blockingRecords } = selectorBlockingJudgment(blocked, inputs)
  const currentHistory = current.histories.find((item) => item.source.scope.target === world.parentScope.target)
  if (!currentHistory) throw new Error('Current clean parent history missing')
  const blockingPrefix = encodeCriterionRecords(
    blockingRecords,
    world.parentScope,
    projection,
    'operator',
    external,
    currentHistory,
  )
  const blockingHistory = blockingPrefix.history
  const admittedDecision = recordsOf(blockingHistory).find((item) => item.recordId === blockingDecision.recordId)
  if (admittedDecision?.kind !== 'decision') throw new Error('Blocking selector decision unavailable')
  const blockingDispositions = criterionDispositionRecords(
    inputs,
    admittedDecision,
    [blockingHistory, ...external],
    beforeReview.catalogues,
    beforeReview.observation.graph,
  ).dispositions
  const blockingDispositionRecords = encodeCriterionRecords(
    blockingDispositions,
    world.parentScope,
    projection,
    'operator',
    external,
    blockingHistory,
  )
  const dispositionHistory = blockingDispositionRecords.history
  const dispositionRefs = blockingDispositions.map((item) => ({
    scope: world.parentScope,
    kind: 'cause-disposition' as const,
    recordId: item.recordId,
  }))
  const blockingVerdict = validateFreshDecision(
    admittedDecision,
    blockingHistory,
    beforeReview.catalogues,
    null,
    external,
    dispositionHistory,
    dispositionRefs,
  )
  if (!blockingVerdict.ok || !blockingVerdict.value.admissible || blockingVerdict.value.verdict !== 'Request changes')
    throw new Error('Blocking selector decision was not admitted: ' + JSON.stringify(blockingVerdict))
  const blockingFinal = buildRecord({
    ...blocked.review,
    payload: { ...blocked.review.payload, causeDispositionRefs: dispositionRefs },
  })
  if (!blockingFinal.ok || blockingFinal.value.kind !== 'review') throw new Error('Invalid blocking review record')
  const blockingFinalRecords = encodeCriterionRecords(
    [blockingFinal.value],
    world.parentScope,
    projection,
    'operator',
    external,
    dispositionHistory,
  )
  for (const comment of [
    ...blockingPrefix.comments,
    ...blockingDispositionRecords.comments,
    ...blockingFinalRecords.comments,
  ])
    await world.gh(cwd, ['api', '--method', 'POST', 'repos/acme/app/issues/200/comments', '-f', 'body=' + comment.body])
  const blockedRead = await installed.readUw(world.parentScope)
  const blockedCompletion = blockedRead.completion.completions.get(scopeKey(world.parentScope))
  if (blockedRead.observation.status !== 'complete' || blockedCompletion?.state !== 'not-complete')
    throw new Error('Blocking current review unexpectedly completed parent: ' + JSON.stringify(blockedCompletion))
  return { admittedDecision, blockingVerdict: blockingVerdict.value.verdict, blockedCompletion }
}

function selectorBlockingJudgment(blocked: ReturnType<typeof criterionEpicReviewGraph>, inputs: ActionInputs) {
  const implementation = inputs.manifest.deliveryData.find((ref) => ref.role === 'implementation')
  if (!implementation) throw new Error('Missing selected implementation evidence')
  const { role: _role, ...citation } = implementation
  const supported = (value: boolean) => ({
    state: 'supported' as const,
    value,
    reason: 'The selected implementation record establishes this judgment',
    references: [citation],
  })
  const judgment = {
    ...blocked.decision.payload.judgment,
    causes: blocked.decision.payload.judgment.causes.map((cause) => ({
      ...cause,
      judgment: { necessary: supported(true), urgent: supported(true), tooLarge: supported(false) },
      proposedDisposition: 'fix-original' as const,
    })),
  }
  const blockingDecision = { ...blocked.decision, payload: { ...blocked.decision.payload, judgment } }
  const synthesis = {
    ...blocked.synthesisContribution,
    payload: {
      ...blocked.synthesisContribution.payload,
      structured: judgment,
      rawAttempts: [
        submission({ id: 'selector-blocking-child', structuredOutput: { status: 'valid', data: judgment } }),
      ],
    },
  }
  const blockingRecords = blocked.records.map((record) =>
    record.recordId === blockingDecision.recordId
      ? blockingDecision
      : record.recordId === synthesis.recordId
        ? synthesis
        : record,
  )
  return { blockingDecision, blockingRecords }
}
