import { threeDeliveredChildren } from '../../../../engine/__tests__/uw-delivery-proof-fixture.ts'
import { canonicalValueDigest } from '../../../../engine/action-input.ts'
import { projectNativeUwChildren } from '../../../../engine/uw-child-admission.ts'
import { scopeKey } from '../../../../engine/uw-graph.ts'
import { recordsOf } from '../../../../engine/workflow-control.ts'
import { sourceRef } from '../../../../roxabi/uw-action-observe.ts'
import type { UwRead } from '../../../../roxabi/uw-contract.ts'
import { currentParentIntegration } from '../../../../roxabi/uw-parent-current-integration.ts'
import { encodeCriterionRecords } from '../../../../testing/criterion-approval.ts'
import { criterionDispositionRecords } from '../../../../testing/criterion-dispositions.ts'
import { criterionEpicReviewGraph } from '../../../../testing/criterion-range-approval.ts'
import { nativeImplementationGit } from '../../../../testing/native-implementation-git.ts'
import { produceParentIntegration } from '../../../../testing/parent-integration-producer.ts'
import { blockingSelectorProof } from './epic-selector-blocking.ts'

/** Produce selector inputs in their own acme/app#200 world, never as Epic driver authority. */
export async function selectorProof() {
  const checkout = nativeImplementationGit()
  try {
    const head = required(checkout.merges[2])
    checkout.publishBase(head)
    const parentCheckout = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
    const initial = parentCheckout.observe()
    if (initial.branch !== null || initial.head !== head || initial.baseTip !== head || initial.remoteTip !== head)
      throw new Error('Selector canonical checkout is not at the published base')
    return await threeDeliveredChildren(
      {
        ...checkout,
        cwd: parentCheckout.cwd,
        trees: checkout.heads.map(checkout.tree),
        baseTrees: [checkout.p0, required(checkout.merges[0]), required(checkout.merges[1])].map(checkout.tree),
        mergeTrees: checkout.merges.map(checkout.tree),
        parentTree: checkout.tree(checkout.parentHead),
        diff: checkout.diff(required(checkout.merges[2]), checkout.parentHead),
      },
      [{ id: 'C1', statement: 'Save keeps the selected region' }],
      'planned',
      async (world) => {
        const produced = await produceParentIntegration(world, parentCheckout, {
          initial,
          candidate: initial,
          command: 'bun test parent.test.ts',
          output: 'PASS parent integration',
        })
        const { beforeReview, installed, code, cwd, completions } = produced
        const history = beforeReview.histories.find((item) => item.source.scope.target === world.parentScope.target)
        if (!history || beforeReview.accepted.status !== 'accepted' || beforeReview.accepted.value.coverage === null)
          throw new Error('Selector fixture requires current accepted parent history and coverage')
        const owner = { scope: world.parentScope, kind: 'mandate' as const, recordId: world.parent.recordId }
        const metadata = beforeReview.accepted.value.coverage.assignments.map((assignment, index) => ({
          source: 'record' as const,
          record: owner,
          selector: '/payload/coverage/assignments/' + index,
          digest: canonicalValueDigest(assignment),
        }))
        const childRefs = completions.map((completion) => {
          const pin = sourceRef(beforeReview.observation.histories, required(completion.sources[0]))
          if (!pin.ok) throw new Error('Missing authenticated child completion source')
          return pin.value
        })
        const prepared = await installed.prepareAction({
          actionId: 'selector-root',
          purpose: 'review',
          subject: { kind: 'uw', uw: world.parentScope, pullRequest: null, binding: null },
          code: { ...code, referenceCommit: code.head },
          stageSources: [],
          expandedContext: [],
        })
        if (!prepared.ok)
          throw new Error('Selector review preparation refused: ' + JSON.stringify(prepared.diagnostics))
        const review = criterionEpicReviewGraph({
          mandate: world.parent,
          inputs: prepared.value.inputs,
          head: code.head,
          range: code.base + '..' + code.head,
          issueRecords: recordsOf(history),
          coverageReferences: [...metadata, ...childRefs],
          prefix: 'selector-review',
        })
        const external = beforeReview.observation.histories.filter(
          (item) => item.source.scope.target !== world.parentScope.target,
        )
        const projection = { catalogues: beforeReview.catalogues, acceptedPolicy: null }
        const prefix = encodeCriterionRecords(
          [review.root, review.spec, review.panel, review.synthesis, review.synthesisContribution, review.decision],
          world.parentScope,
          projection,
          'operator',
          external,
          history,
        )
        const decision = recordsOf(prefix.history).find((item) => item.recordId === review.decision.recordId)
        if (decision?.kind !== 'decision') throw new Error('Selector decision was not authenticated')
        const assessed = criterionDispositionRecords(
          prepared.value.inputs,
          decision,
          [prefix.history, ...external],
          beforeReview.catalogues,
          beforeReview.observation.graph,
        )
        const dispositions = encodeCriterionRecords(
          assessed.dispositions,
          world.parentScope,
          projection,
          'operator',
          external,
          prefix.history,
        )
        const final = {
          ...review.review,
          payload: {
            ...review.review.payload,
            causeDispositionRefs: assessed.dispositions.map((item) => ({
              scope: world.parentScope,
              kind: 'cause-disposition' as const,
              recordId: item.recordId,
            })),
          },
        }
        const sealed = encodeCriterionRecords(
          [final],
          world.parentScope,
          projection,
          'operator',
          external,
          dispositions.history,
        )
        for (const comment of [...prefix.comments, ...dispositions.comments, ...sealed.comments])
          await world.gh(cwd, [
            'api',
            '--method',
            'POST',
            'repos/acme/app/issues/200/comments',
            '-f',
            'body=' + comment.body,
          ])
        const current = await installed.readUw(world.parentScope)
        const completion = current.completion.completions.get(scopeKey(world.parentScope))
        const integration = currentParentIntegration(current, code.base, code.head)
        if (
          current.observation.status !== 'complete' ||
          completion?.state !== 'complete' ||
          !integration.ok ||
          integration.value === null
        )
          throw new Error('Selector parent completion refused: ' + JSON.stringify({ completion, integration }))
        const { childCompletions, ownUws } = await selectorChildEvidence(world, current)
        const { admittedDecision, blockingVerdict, blockedCompletion } = await blockingSelectorProof({
          world,
          beforeReview,
          installed,
          code,
          cwd,
          current,
          history,
          metadata,
          childRefs,
          inputs: prepared.value.inputs,
          external,
        })
        return {
          inputs: prepared.value.inputs,
          integration,
          completion,
          childCompletions,
          code,
          decision: { scope: world.parentScope, kind: 'decision' as const, recordId: decision.recordId },
          blockingDecision: {
            scope: world.parentScope,
            kind: 'decision' as const,
            recordId: admittedDecision.recordId,
          },
          blockingVerdict,
          blockingCompletion: blockedCompletion,
          children: world.reviews.map((child, index) => ({
            uw: child.uw,
            head: child.head,
            base: child.base,
            merge: child.merge,
            ownUw: required(ownUws[index]),
          })),
        }
      },
    )
  } finally {
    checkout.cleanup()
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Selector fixture is missing required observed evidence')
  return value
}

async function selectorChildEvidence(
  world: Parameters<Parameters<typeof threeDeliveredChildren>[3]>[0],
  current: UwRead,
) {
  const childCompletions = world.reviews.map((child) => current.completion.completions.get(scopeKey(child.uw)))
  if (childCompletions.some((child) => child?.state !== 'complete'))
    throw new Error('Selector child completion missing')
  const reader = current.observedReader
  if (!reader) throw new Error('Same-cut child reader unavailable')
  const childReads = await Promise.all(world.reviews.map((child) => reader.readUw(child.uw)))
  const ownUws = childReads.map((read) => {
    if (read.accepted.status !== 'accepted' || !read.identity.ok || read.graph.status !== 'complete')
      throw new Error('Same-cut accepted child authority unavailable')
    const children = projectNativeUwChildren({ uw: read.uw, graph: read.graph, accepted: read.accepted })
    if (!children.ok) throw new Error(`Same-cut child role unavailable: ${JSON.stringify(children.diagnostics)}`)
    return {
      status: 'accepted' as const,
      graphComplete: true as const,
      role: children.value.length ? ('parent' as const) : ('leaf' as const),
      accepted: read.accepted.value,
      identityAllocations: [...read.identity.value.allocations].map(([id, allocationRef]) => ({
        id,
        allocationRef,
      })),
    }
  })
  return { childCompletions, ownUws }
}
