import { expect, test } from 'vitest'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { criterionDispositionRecords } from '../../testing/criterion-dispositions.ts'
import { runNestedDeliveryScenario } from '../../testing/nested-delivery-world.ts'
import { finding, submission } from '../../testing/record-builders.ts'
import { contribution, decision } from '../../testing/record-decisions.ts'
import { roxabiRecordFixtures } from '../../testing/roxabi-presets.ts'
import type { FindingTarget } from '../finding-target-schema.ts'
import { findingSchema } from '../record-values.ts'
import { validateFreshDecision } from '../review-fresh-decision.ts'
import { recordsOf } from '../workflow-control.ts'

test('authenticated review preserves colliding inherited invariant owners through fresh decision', async () => {
  const { leafReviewContext: context } = await runNestedDeliveryScenario('middle-missing-coverage')
  const { inputs, review, issueHistory, pullHistory, parents, graph } = context
  if (inputs.manifest.spec.kind !== 'accepted') throw new Error('Expected accepted effective Spec')
  const effective = inputs.manifest.spec.effective
  const inherited = effective.inherited.invariants.map((item) => item.target)
  if (inherited.length !== 2 || !inherited[0] || !inherited[1]) throw new Error('Expected two inherited invariants')
  expect(inherited.map((target) => target.id)).toEqual(['I1', 'I1'])
  expect(inherited[0].spec).not.toEqual(inherited[1].spec)
  const projection = roxabiRecordFixtures().projection
  const scope = pullHistory.source.scope

  function assemble(targets: FindingTarget[]) {
    const originals = targets.map((target, index) => ({
      id: `${review.panel.recordId}:f${index}`,
      attemptIndex: 0,
      data: finding({ label: 'suggestion', target }),
    }))
    const panel = contribution({
      id: review.panel.recordId,
      scope,
      inventoryId: review.root.recordId,
      findings: originals,
    })
    panel.payload.host = review.panel.payload.host
    const finals = originals.map((item, index) => ({
      id: `qualified-final-${index}`,
      label: 'suggestion' as const,
      impactReason: 'The invariant is not preserved.',
      state: 'usable' as const,
      target: item.data.target,
      sourceFindingIds: [item.id],
      description: 'Preserve the owning invariant.',
    }))
    const draft = decision({
      id: review.decision.recordId,
      scope,
      originalContributionId: review.synthesisContribution.recordId,
      sourceContributionIds: [review.spec.recordId, panel.recordId],
      findings: finals,
    })
    if (draft.payload.judgment.purpose !== 'review' || review.decision.payload.judgment.purpose !== 'review')
      throw new Error('Expected review')
    const judgment = {
      ...draft.payload.judgment,
      criterionVerdicts: review.decision.payload.judgment.criterionVerdicts,
    }
    const decided = { ...draft, payload: { ...draft.payload, judgment } }
    const synthesis = contribution({
      id: review.synthesisContribution.recordId,
      scope,
      inventoryId: review.synthesis.recordId,
      phase: 'synthesis',
      role: 'R-synthesis',
      slotId: 'synthesis-0',
      chunk: null,
      content: 'decision',
      structured: judgment,
      rawAttempts: [
        submission({
          id: `child-${review.synthesisContribution.recordId}`,
          structuredOutput: { status: 'valid', data: judgment },
        }),
      ],
    })
    const prefix = encodeCriterionRecords(
      [review.root, review.spec, panel, review.synthesis, synthesis, decided],
      scope,
      projection,
      'operator',
      [issueHistory, ...parents],
      pullHistory,
    )
    const bound = recordsOf(prefix.history).find((record) => record.recordId === decided.recordId)
    if (bound?.kind !== 'decision') throw new Error('Decision not authenticated')
    return { prefix, bound, originals, finals }
  }

  const good = assemble(inherited)
  expect(good.bound.payload.judgment.findings.map((item) => item.target)).toEqual(inherited)
  const recordedPanel = recordsOf(good.prefix.history).find((record) => record.recordId === review.panel.recordId)
  if (recordedPanel?.kind !== 'contribution') throw new Error('Panel contribution not authenticated')
  expect(recordedPanel.payload.findings?.map((item) => findingSchema.parse(item.data).target)).toEqual(inherited)
  const assessed = criterionDispositionRecords(
    inputs,
    good.bound,
    [issueHistory, good.prefix.history, ...parents],
    projection.catalogues,
    graph,
  )
  expect(
    assessed.dispositions
      .filter((item) => item.payload.subject.kind === 'cause')
      .flatMap((item) =>
        item.payload.subject.kind === 'cause' ? item.payload.subject.findings.map((finding) => finding.target) : [],
      ),
  ).toEqual(inherited)
  const persisted = encodeCriterionRecords(
    assessed.dispositions,
    effective.own.uw,
    projection,
    'operator',
    [good.prefix.history, ...parents],
    issueHistory,
  )
  const refs = assessed.dispositions.map((item) => ({
    scope: effective.own.uw,
    kind: 'cause-disposition' as const,
    recordId: item.recordId,
  }))
  const fresh = validateFreshDecision(
    good.bound,
    good.prefix.history,
    projection.catalogues,
    null,
    [good.prefix.history, ...parents],
    persisted.history,
    refs,
  )
  expect(fresh, JSON.stringify(fresh)).toMatchObject({ ok: true, value: { admissible: true } })

  for (const target of [
    { ...inherited[0], spec: { ...inherited[0].spec, version: 'c'.repeat(64) } },
    {
      ...inherited[0],
      spec: { ...inherited[0].spec, sourceAccepted: { ...inherited[0].spec.sourceAccepted, recordId: 'wrong-source' } },
    },
    {
      ...inherited[0],
      spec: {
        ...inherited[0].spec,
        uw: { repository: 'foreign/app', target: 'foreign/app#1' },
        sourceAccepted: {
          ...inherited[0].spec.sourceAccepted,
          scope: { repository: 'foreign/app', target: 'foreign/app#1' },
        },
      },
    },
  ]) {
    const invalid = assemble([target])
    const rejected = criterionDispositionRecords(
      inputs,
      invalid.bound,
      [issueHistory, invalid.prefix.history, ...parents],
      projection.catalogues,
      graph,
    )
    expect(
      rejected.dispositions.flatMap((item) => item.payload.diagnostics.map((diagnostic) => diagnostic.code)),
    ).toContain('finding-target-spec-mismatch')
    const causes = rejected.dispositions.filter((item) => item.payload.subject.kind === 'cause')
    expect(causes).toHaveLength(1)
    expect(causes[0]?.payload.outcome).toMatchObject({ state: 'final', disposition: 'report', blocking: false })
  }
}, 60_000)
