import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Label, Scope } from '../engine/record-values.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { defaultEpicInputs } from './epic-review-input-fixture.ts'
import { finding, reviewRoot, submission, synthesisInventory, TEST_HEAD, TEST_SCOPE } from './record-builders.ts'
import { contribution, decision, finalReview } from './record-decisions.ts'
import { history, operation } from './record-history.ts'

export function reviewGraph(
  options: {
    prefix?: string
    label?: Label
    head?: string
    empty?: boolean
    inputs?: ActionInputs
    scope?: Scope
  } = {},
) {
  const prefix = options.prefix ?? 'review'
  const rootId = `${prefix}-root`
  const synthesisId = `${prefix}-synthesis`
  const panelId = `${prefix}-panel`
  const synthesisContributionId = `${prefix}-decision-source`
  const decisionId = `${prefix}-decision`
  const reviewId = `${prefix}-final`
  const head = options.head ?? TEST_HEAD
  const targetScope =
    options.inputs?.manifest.spec.kind === 'accepted'
      ? options.inputs.manifest.spec.effective.own.uw
      : (options.scope ?? TEST_SCOPE)
  const baseRoot = reviewRoot({ id: rootId, head, inputSnapshot: options.inputs, scope: options.scope })
  if (baseRoot.payload.stage !== 'initial' || baseRoot.payload.purpose !== 'review')
    throw new Error('Expected initial review inventory')
  const snapshot = baseRoot.payload.inputSnapshot
  const actions = new Map(
    baseRoot.payload.slots.map((slot) => [slot.slotId, { actionId: `${rootId}-${slot.slotId}`, inputs: snapshot }]),
  )
  const root = {
    ...baseRoot,
    payload: {
      ...baseRoot.payload,
      slots: baseRoot.payload.slots.map((slot) => ({
        ...slot,
        action: actions.get(slot.slotId),
      })),
    },
  }
  const specStructured = { findings: [], specRows: [] }
  const spec = contribution({
    id: `${prefix}-spec`,
    scope: options.scope,
    inventoryId: rootId,
    phase: 'spec',
    role: 'R-spec',
    slotId: 'spec-0',
    chunk: null,
    findings: [],
    structured: specStructured,
    rawAttempts: [
      submission({ id: `child-${prefix}-spec`, structuredOutput: { status: 'valid', data: specStructured } }),
    ],
  })
  const panelFindings = options.empty
    ? []
    : [
        {
          id: `${panelId}:f0`,
          attemptIndex: 0,
          data: finding({
            label: options.label ?? 'issue',
            target: {
              format: 'omp-build-finding-target/1',
              kind: 'outside-spec',
              uw: targetScope,
              element: 'widget save',
            },
          }),
        },
      ]
  const basePanel = contribution({ id: panelId, inventoryId: rootId, findings: panelFindings, scope: options.scope })
  const panel = {
    ...basePanel,
    payload: {
      ...basePanel.payload,
      host: {
        ...basePanel.payload.host,
        action: actions.get('panel-0'),
      },
    },
  }
  const synthesis = synthesisInventory({
    id: synthesisId,
    rootId,
    head,
    scope: options.scope,
    input: root.payload.input,
    actionInputDigest: root.payload.actionInputDigest,
    actionInputs:
      options.inputs ??
      (root.payload.stage === 'initial' && root.payload.purpose === 'review' ? root.payload.inputSnapshot : undefined),
  })
  const reviewDecision = decision({
    id: decisionId,
    scope: options.scope,
    originalContributionId: synthesisContributionId,
    sourceContributionIds: [spec.recordId, panelId],
    findings: options.empty
      ? []
      : [
          {
            id: `${prefix}-finding-final`,
            label: options.label ?? 'issue',
            impactReason: 'The saved region is wrong.',
            state: 'usable',
            target: {
              format: 'omp-build-finding-target/1',
              kind: 'outside-spec',
              uw: targetScope,
              element: 'widget save',
            },
            sourceFindingIds: [`${panelId}:f0`],
            description: 'Save the selected region rather than the stale region.',
          },
        ],
  })
  const synthesisContribution = contribution({
    id: synthesisContributionId,
    scope: options.scope,
    inventoryId: synthesisId,
    phase: 'synthesis',
    role: 'R-synthesis',
    slotId: 'synthesis-0',
    chunk: null,
    content: 'decision',
    rawAttempts: [
      submission({
        id: `child-${synthesisContributionId}`,
        structuredOutput: { status: 'valid', data: reviewDecision.payload.judgment },
      }),
    ],
    structured: reviewDecision.payload.judgment,
  })
  const review = finalReview({
    id: reviewId,
    head,
    inventoryIds: [rootId, synthesisId],
    decisionId,
    scope: options.scope,
    input: root.payload.input,
  })
  const records = [root, spec, panel, synthesis, synthesisContribution, reviewDecision, review] as CanonicalRecord[]
  const observed = history(records)
  return {
    root,
    spec,
    panel,
    synthesis,
    synthesisContribution,
    decision: reviewDecision,
    review,
    records,
    history: { ...observed, source: { ...observed.source, scope: options.scope ?? observed.source.scope } },
  }
}

/** Authenticated PR review inputs tied to the accepted mandate and the actual PR binding. */
export function acceptedPullRequestReviewGraph(options: {
  mandate: Extract<CanonicalRecord, { kind: 'mandate' }>
  binding: CanonicalRecord
  prefix?: string
  label?: Label
  inputs?: ActionInputs
}) {
  if (options.binding.kind !== 'workflow-binding') throw new Error('Expected a workflow-binding record')
  const scope = { repository: options.binding.repository, target: options.binding.target }
  const accepted = acceptedActionInputs(options.mandate, 'review')
  const manifest = {
    ...accepted.manifest,
    code: { ...accepted.manifest.code, repository: scope.repository },
    subject: {
      kind: 'uw' as const,
      uw: options.mandate.payload.ownSpec.uw,
      pullRequest: scope,
      binding: {
        source: 'record' as const,
        record: { scope, kind: 'workflow-binding' as const, recordId: options.binding.recordId },
        selector: '/payload',
        digest: canonicalValueDigest(options.binding.payload),
      },
    },
  }
  const inputs = options.inputs ?? { ...accepted, manifest, fingerprint: actionInputDigest(manifest) }
  const graph = reviewGraph({
    prefix: options.prefix,
    label: options.label,
    inputs,
    scope,
    head: inputs.manifest.code.head,
  })
  return {
    ...graph,
    inputs,
    history: {
      ...graph.history,
      operations: [operation(options.binding, { authority: 'accounted' }), ...graph.history.operations],
    },
  }
}

export function epicReviewGraph(
  options: {
    prefix?: string
    head?: string
    empty?: boolean
    inputs?: ActionInputs
    range?: string
    scope?: Scope
  } = {},
) {
  const scope = options.scope ?? TEST_SCOPE
  const range = options.range ?? `0000000000000000000000000000000000000000..${options.head ?? TEST_HEAD}`
  const inputs = options.inputs ?? defaultEpicInputs(scope, range)
  const graph = reviewGraph({
    prefix: options.prefix ?? 'epic',
    head: options.head,
    empty: options.empty,
    inputs,
    scope,
  })
  const root = reviewRoot({
    id: graph.root.recordId,
    scope,
    head: options.head,
    inputSnapshot: inputs,
    slots: graph.root.payload.slots,
    subject: {
      kind: 'epic-range',
      range,
    },
  })
  const reviewDecision = {
    ...graph.decision,
    payload: { ...graph.decision.payload, judgment: { ...graph.decision.payload.judgment, standards: null } },
  }
  const synthesisContribution = {
    ...graph.synthesisContribution,
    payload: {
      ...graph.synthesisContribution.payload,
      rawAttempts: [
        submission({
          id: `child-${graph.synthesisContribution.recordId}`,
          structuredOutput: { status: 'valid', data: reviewDecision.payload.judgment },
        }),
      ],
      structured: reviewDecision.payload.judgment,
    },
  }
  const records = graph.records
    .filter((record) => record.kind !== 'review')
    .map((record) => {
      if (record.recordId === root.recordId) return root
      if (record.recordId === reviewDecision.recordId) return reviewDecision
      if (record.recordId === synthesisContribution.recordId) return synthesisContribution
      return record
    })
  const observed = history(records)
  return {
    ...graph,
    root,
    synthesisContribution,
    decision: reviewDecision,
    records,
    history: { ...observed, source: { ...observed.source, scope: options.scope ?? observed.source.scope } },
  }
}
