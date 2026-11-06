import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { sourceRef } from '../../roxabi/uw-action-observe.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { criterionDispositionRecords } from '../../testing/criterion-dispositions.ts'
import { criterionEpicReviewGraph } from '../../testing/criterion-range-approval.ts'
import { nativeImplementationGit } from '../../testing/native-implementation-git.ts'
import { produceParentIntegration } from '../../testing/parent-integration-producer.ts'
import { canonicalValueDigest } from '../action-input.ts'
import { parseRecord } from '../record-construction.ts'
import { validateFreshDecision } from '../review-fresh-decision.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import { scopeKey } from '../uw-graph.ts'
import { recordsOf } from '../workflow-control.ts'
import { threeDeliveredChildren } from './uw-delivery-proof-fixture.ts'

function assertPinnedChildSources(
  completions: Awaited<ReturnType<typeof produceParentIntegration>>['completions'],
  histories: Parameters<typeof sourceRef>[0],
  stageSources: readonly unknown[],
) {
  for (const child of completions) {
    const finalReview = child.sources.find((ref) => ref.kind === 'review')
    if (!finalReview) throw new Error('Completed child lacks its authenticated final review source')
    const pinned = sourceRef(histories, finalReview)
    if (!pinned.ok) throw new Error('Completed child final review source is not readable')
    expect(stageSources).toContainEqual(pinned.value)
  }
}
function childProofSources(
  completions: Awaited<ReturnType<typeof produceParentIntegration>>['completions'],
  histories: Parameters<typeof sourceRef>[0],
) {
  return completions.map((item) => {
    const source = item.sources[0]
    if (source === undefined) throw new Error('Missing child proof source')
    const pinned = sourceRef(histories, source)
    if (!pinned.ok) throw new Error('Missing child proof source')
    return pinned.value
  })
}

test.each([
  'complete',
  'complete-no-new-commit',
  'complete-empty-range',
  'complete-two-criteria',
  'missing-coverage',
  'missing-child',
  'missing-second-criterion-coverage',
] as const)(
  'parent direct integration and coverage citations: %s',
  async (scenario) => {
    const checkout = nativeImplementationGit()
    const emptyRange = scenario === 'complete-empty-range'
    const noNewCommit = scenario === 'complete-no-new-commit' || emptyRange
    const twoCriteria = scenario === 'complete-two-criteria' || scenario === 'missing-second-criterion-coverage'
    const parentCriteria = [
      { id: 'C1' as const, statement: 'Save keeps the selected region' },
      ...(twoCriteria ? [{ id: 'C2' as const, statement: 'Region boundaries survive child integration' }] : []),
    ]
    try {
      const [firstMerge, secondMerge, thirdMerge] = checkout.merges
      if (firstMerge === undefined || secondMerge === undefined || thirdMerge === undefined)
        throw new Error('Expected three child merges')
      await checkout.publishBase(thirdMerge)
      const parentCheckout = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
      const startingHead = thirdMerge
      await threeDeliveredChildren(
        {
          ...checkout,
          cwd: parentCheckout.cwd,
          trees: checkout.heads.map(checkout.tree),
          baseTrees: [checkout.p0, firstMerge, secondMerge].map(checkout.tree),
          mergeTrees: checkout.merges.map(checkout.tree),
          parentTree: checkout.tree(checkout.parentHead),
          diff: checkout.diff(thirdMerge, checkout.parentHead),
        },
        parentCriteria,
        'planned',
        async (world) => {
          const [firstReview, secondReview, thirdReview] = world.reviews
          const thirdWorldMerge = world.merges[2]
          if (!firstReview || !secondReview || !thirdReview || thirdWorldMerge === undefined)
            throw new Error('Expected three delivered children')
          const initial = parentCheckout.observe()
          async function produceAdmittedIntegration() {
            const { cwd, installed, completions, opened, code, integrationRecordId, beforeReview } =
              await produceParentIntegration(world, parentCheckout, {
                initial,
                candidate: parentCheckout.observe(),
                command: 'bun test parent.test.ts',
                output: 'PASS parent integration',
              })
            expect(beforeReview.completion.completions.get(scopeKey(world.parentScope))?.state).not.toBe('complete')
            for (const child of world.reviews)
              expect(beforeReview.completion.completions.get(scopeKey(child.uw))).toMatchObject({ state: 'complete' })
            const parentHistory = beforeReview.histories.find(
              (item) => item.source.scope.target === world.parentScope.target,
            )
            const integrated =
              parentHistory && recordsOf(parentHistory).find((item) => item.recordId === integrationRecordId)
            if (
              !parentHistory ||
              integrated?.kind !== 'action-receipt' ||
              integrated.payload.action !== 'integrate' ||
              integrated.payload.phase !== 'result' ||
              !integrated.payload.structured ||
              integrated.payload.structured.outcome !== 'integrated' ||
              !integrated.payload.admission?.admitted
            )
              throw new Error('Native producer did not publish an admitted integration result')
            const integrationOutput = integrated.payload.structured
            expect(integrated.payload.structured.code).toEqual(code)
            const declaration = integrated.payload.structured.criteria[0]
            if (declaration?.verification !== 'evidence' || !declaration.evidence[0])
              throw new Error('Missing actual parent criterion evidence')
            return {
              cwd,
              installed,
              completions,
              opened,
              code,
              beforeReview,
              parentHistory,
              integrated,
              integrationOutput,
              declaration,
            }
          }
          const {
            cwd,
            installed,
            completions,
            opened,
            code,
            beforeReview,
            parentHistory,
            integrated,
            integrationOutput,
            declaration,
          } = await produceAdmittedIntegration()
          const integrationRef = {
            scope: world.parentScope,
            kind: 'action-receipt' as const,
            recordId: integrated.recordId,
          }
          const integration = {
            source: 'record' as const,
            record: integrationRef,
            selector: '/payload/structured/code',
            digest: canonicalValueDigest(integrationOutput.code),
          }
          const implementation = {
            source: 'record' as const,
            record: integrationRef,
            selector: '/payload/structured/criteria/0',
            digest: canonicalValueDigest(declaration),
          }
          async function prepareParentReviewInputs() {
            if (beforeReview.accepted.status !== 'accepted' || beforeReview.accepted.value.coverage === null)
              throw new Error('Expected accepted parent coverage')
            const coverage = beforeReview.accepted.value.coverage
            const metadata = coverage.assignments.map((assignment, index) => ({
              source: 'record' as const,
              record: { scope: world.parentScope, kind: 'mandate' as const, recordId: world.parent.recordId },
              selector: `/payload/coverage/assignments/${index}`,
              digest: canonicalValueDigest(assignment),
            }))
            const childRefs = childProofSources(completions, beforeReview.observation.histories)
            const preparedReview = await installed.prepareAction({
              actionId: 'parent-integration-root',
              purpose: 'review',
              subject: integrated.payload.inputs.manifest.subject,
              code: { ...code, referenceCommit: code.head },
              stageSources: [],
              expandedContext: [],
            })
            if (!preparedReview.ok)
              throw new Error(`Fresh parent review preparation refused: ${JSON.stringify(preparedReview.diagnostics)}`)
            const inputs = preparedReview.value.inputs
            expect(inputs.manifest.deliveryData).toEqual(
              expect.arrayContaining([
                { ...integration, role: 'integration' },
                { ...implementation, role: 'implementation' },
              ]),
            )
            return { inputs, coverage, metadata, childRefs }
          }
          const { inputs, coverage, metadata, childRefs } = await prepareParentReviewInputs()
          const review = criterionEpicReviewGraph({
            mandate: world.parent,
            inputs,
            head: code.head,
            range: `${code.base}..${code.head}`,
            issueRecords: recordsOf(parentHistory),
            prefix: 'parent-integration',
            coverageReferences: [
              ...(scenario === 'missing-coverage'
                ? []
                : metadata.filter(
                    (_, index) =>
                      scenario !== 'missing-second-criterion-coverage' ||
                      coverage.assignments[index]?.criterion !== 'C2',
                  )),
              ...childRefs.filter((_, index) => scenario !== 'missing-child' || index !== 1),
            ],
          })
          const { root, spec, decision, synthesisContribution: synthesis } = review
          const external = beforeReview.observation.histories.filter(
            (item) => item.source.scope.target !== world.parentScope.target,
          )
          const prefix = encodeCriterionRecords(
            [root, spec, review.panel, review.synthesis, synthesis, decision],
            world.parentScope,
            { catalogues: beforeReview.catalogues, acceptedPolicy: null },
            'operator',
            external,
            parentHistory,
          )
          const boundDecision = recordsOf(prefix.history).find((record) => record.recordId === decision.recordId)
          if (boundDecision?.kind !== 'decision') throw new Error('Parent decision not authenticated')
          const authenticatedDecision = boundDecision
          const assessed = criterionDispositionRecords(
            inputs,
            boundDecision,
            [prefix.history, ...external],
            beforeReview.catalogues,
            beforeReview.observation.graph,
          )
          const dispositions = encodeCriterionRecords(
            assessed.dispositions,
            world.parentScope,
            { catalogues: beforeReview.catalogues, acceptedPolicy: null },
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
            { catalogues: beforeReview.catalogues, acceptedPolicy: null },
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
              `body=${comment.body}`,
            ])
          const current = await installed.readUw(world.parentScope)
          if (current.observation.status !== 'complete') throw new Error('Final native observation incomplete')
          const observation = current.observation
          const rootFacts = current.observation.delivery.find((item) => item.uw.target === world.parentScope.target)
          const child2Facts = current.observation.delivery.find((item) => item.uw.target === secondReview.uw.target)
          const child3Facts = current.observation.delivery.find((item) => item.uw.target === thirdReview.uw.target)
          expect(rootFacts?.commits).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: { repository: code.repository, commit: code.head },
                parents: [world.merges[1], world.heads[2]],
              }),
            ]),
          )
          expect(child3Facts?.commits).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: { repository: code.repository, commit: world.merges[2] },
                parents: [world.merges[1], world.heads[2]],
              }),
            ]),
          )
          expect(child2Facts?.commits).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: { repository: code.repository, commit: world.merges[1] },
                parents: [world.merges[0], world.heads[1]],
              }),
            ]),
          )
          function assertCompletionBoundaries() {
            const missingIntegration = {
              ...observation,
              delivery: observation.delivery.map((item) =>
                item.uw.target === world.parentScope.target ? { ...item, integrations: [] } : item,
              ),
            }
            const held = assessUwCompletion(missingIntegration)
            expect(held.completions.get(scopeKey(world.parentScope))?.state).not.toBe('complete')
            for (const child of world.reviews)
              expect(held.completions.get(scopeKey(child.uw))).toMatchObject({ state: 'complete' })
            const badIntegration = {
              ...observation,
              delivery: observation.delivery.map((item) =>
                item.uw.target === world.parentScope.target
                  ? {
                      ...item,
                      integrations: item.integrations.map((candidate) => ({
                        ...candidate,
                        source: { ...candidate.source, digest: 'f'.repeat(64) },
                      })),
                    }
                  : item,
              ),
            }
            const badResult = assessUwCompletion(badIntegration)
            expect(badResult.completions.get(scopeKey(world.parentScope))).toMatchObject({ state: 'not-complete' })
            for (const child of world.reviews)
              expect(badResult.completions.get(scopeKey(child.uw))).toMatchObject({ state: 'complete' })
          }
          function assertParentCompletion() {
            const parentCompletion = current.completion.completions.get(scopeKey(world.parentScope))
            if (scenario === 'complete' || noNewCommit || scenario === 'complete-two-criteria') {
              expect(
                parentCompletion,
                JSON.stringify({
                  parentCompletion,
                  integrated: integrationOutput,
                  currentCoverage: current.accepted.status === 'accepted' ? current.accepted.value.coverage : null,
                  children: completions.map((child) => current.completion.completions.get(scopeKey(child.uw))),
                  delivery: observation.delivery,
                }),
              ).toMatchObject({
                state: 'complete',
                role: 'parent',
                code: inputs.manifest.code,
                sources: expect.arrayContaining([integrationRef]),
              })
            } else {
              expect(parentCompletion).toMatchObject({
                state: 'not-complete',
                diagnostics: expect.arrayContaining([
                  expect.objectContaining({ code: 'integration-coverage-not-cited' }),
                ]),
              })
            }
            for (const child of world.reviews)
              expect(current.completion.completions.get(scopeKey(child.uw))).toMatchObject({ state: 'complete' })
          }
          function assertMissingHead() {
            const missingHead = {
              ...observation,
              delivery: observation.delivery.map((item) => ({
                ...item,
                commits: item.commits.filter((commit) => commit.code.commit !== code.head),
              })),
            }
            const withoutHead = assessUwCompletion(missingHead)
            expect(withoutHead.completions.get(scopeKey(world.parentScope))?.state).not.toBe('complete')
            for (const child of world.reviews) {
              const completion = withoutHead.completions.get(scopeKey(child.uw))
              if (child.merge === code.head) expect(completion?.state).not.toBe('complete')
              else expect(completion).toMatchObject({ state: 'complete' })
            }
          }
          assertCompletionBoundaries()
          assertParentCompletion()
          assertMissingHead()
          function assertReviewClosure() {
            // Exercise the live review consumer against the actual START/result published above.
            // Each damaged closure keeps the same decision and input snapshot; the positive
            // must succeed first so an earlier unrelated refusal cannot satisfy the negatives.
            const dispositionRefs = assessed.dispositions.map((item) => ({
              scope: world.parentScope,
              kind: 'cause-disposition' as const,
              recordId: item.recordId,
            }))
            const fresh = (deliveryHistory: typeof dispositions.history) =>
              validateFreshDecision(
                authenticatedDecision,
                prefix.history,
                beforeReview.catalogues,
                null,
                external,
                deliveryHistory,
                dispositionRefs,
              )
            const positive = fresh(dispositions.history)
            expect(positive, JSON.stringify(positive)).toMatchObject({ ok: true })
            const nativeResult = dispositions.history.operations.find((item) => item.recordId === integrated.recordId)
            const nativeStart = dispositions.history.operations.find((item) => item.recordId === opened.start.recordId)
            if (
              !nativeResult ||
              !nativeStart ||
              nativeStart.record?.kind !== 'action-receipt' ||
              nativeStart.record.payload.action !== 'integrate' ||
              nativeStart.record.payload.phase !== 'start'
            )
              throw new Error('Actual integration START/result closure is missing')
            const startRecord = nativeStart.record
            const startPayload = nativeStart.record.payload
            const nativeStartParts = nativeStart.parts
            const boundResult = nativeResult
            function assertCapturedChildSources() {
              expect(startPayload.inputs.manifest.code.head).toBe(startingHead)
              if (noNewCommit) expect(code.head).toBe(startingHead)
              if (emptyRange) expect(code.base).toBe(code.head)
              assertPinnedChildSources(
                completions,
                beforeReview.observation.histories,
                startPayload.inputs.stageSources,
              )
            }
            assertCapturedChildSources()
            function assertChangedWitness() {
              const resultParts = new Set(boundResult.parts.map((part) => part.nativeId))
              const source = dispositions.history.source
              const withoutResult = decodeHistory({
                ...source,
                comments: source.comments.filter((comment) => !resultParts.has(comment.nativeId)),
              })
              expect(fresh(withoutResult).ok).toBe(false)
              const foreignResult = decodeHistory({
                ...source,
                comments: source.comments.map((comment) =>
                  resultParts.has(comment.nativeId) ? { ...comment, author: 'foreign' } : comment,
                ),
              })
              expect(fresh(foreignResult).ok).toBe(false)
              const incomplete = decodeHistory({ ...source, complete: false })
              expect(fresh(incomplete).ok).toBe(false)
              const changedStart = parseRecord({
                ...startRecord,
                payload: {
                  ...startPayload,
                  inputs: { ...startPayload.inputs, stageSources: [] },
                },
              })
              if (!changedStart.ok) throw new Error('Changed START must retain canonical record grammar')
              const encodedStart = encodeParts(changedStart.value, '# changed integration start', 65_536)
              if (!encodedStart.ok) throw new Error('Changed START cannot be encoded')
              const startParts = new Set(nativeStartParts.map((part) => part.nativeId))
              const changedClosure = decodeHistory({
                ...source,
                comments: [
                  ...source.comments.filter((comment) => !startParts.has(comment.nativeId)),
                  ...encodedStart.value.map((body, index) => {
                    const nativeId = String(9000000 + index)
                    return {
                      locator: `${world.parentScope.target}:comment:${nativeId}`,
                      nativeId,
                      body,
                      author: 'operator',
                      createdAt: '2026-10-21T00:00:00Z',
                      updatedAt: '2026-10-21T00:00:00Z',
                    }
                  }),
                ],
              })
              const changed = fresh(changedClosure)
              expect(changed).toMatchObject({
                ok: false,
                diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'integration-start-unpaired' })]),
              })
            }
            assertChangedWitness()
          }
          assertReviewClosure()
        },
      )
    } finally {
      checkout.cleanup()
    }
  },
  60_000,
)

test.each(['unpublished-at-start', 'moves-after-start'] as const)(
  'parent integration refuses an unpublished candidate: %s',
  async (scenario) => {
    const checkout = nativeImplementationGit()
    try {
      const [firstMerge, secondMerge, thirdMerge] = checkout.merges
      if (!firstMerge || !secondMerge || !thirdMerge) throw new Error('Expected three child merges')
      await checkout.publishBase(thirdMerge)
      const parentCheckout = await checkout.parent({ repository: 'acme/app', target: 'acme/app#200' })
      const published = parentCheckout.observe()
      parentCheckout.checkout(checkout.parentHead)
      const unpublished = parentCheckout.observe()
      parentCheckout.checkout(thirdMerge)
      await threeDeliveredChildren(
        {
          ...checkout,
          cwd: parentCheckout.cwd,
          trees: checkout.heads.map(checkout.tree),
          baseTrees: [checkout.p0, firstMerge, secondMerge].map(checkout.tree),
          mergeTrees: checkout.merges.map(checkout.tree),
          parentTree: checkout.tree(checkout.parentHead),
          diff: checkout.diff(thirdMerge, checkout.parentHead),
        },
        [{ id: 'C1', statement: 'Save keeps the selected region' }],
        'planned',
        async (world) => {
          await expect(
            produceParentIntegration(world, parentCheckout, {
              initial: scenario === 'unpublished-at-start' ? unpublished : published,
              candidate: unpublished,
              command: 'bun test parent.test.ts',
              output: 'PASS parent integration',
            }),
          ).rejects.toThrow('integration-base-not-published')
          const read = await world.operations.readUw(world.parentScope)
          expect(read.completion.completions.get(scopeKey(world.parentScope))?.state).not.toBe('complete')
          for (const child of world.reviews)
            expect(read.completion.completions.get(scopeKey(child.uw))).toMatchObject({ state: 'complete' })
        },
      )
    } finally {
      checkout.cleanup()
    }
  },
  60_000,
)
