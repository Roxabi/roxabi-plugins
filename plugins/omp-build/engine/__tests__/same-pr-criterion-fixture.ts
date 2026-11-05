import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import { type CriterionDeclaration, criterionDeclarationSchema } from '../criterion-evidence-schema.ts'
import { type CriterionVerdict, criterionVerdictSchema } from '../criterion-verdict-schema.ts'
import { type CriterionTarget, FINDING_TARGET_FORMAT } from '../finding-target-schema.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Scope } from '../record-values.ts'
import type { SpecEffective } from '../spec-effective.ts'
import { type MandateRecord, mandateScope, type ReceiptRecord } from '../workflow-control.ts'
import {
  captureSamePrSubmission,
  replaceSamePrSourceContributions,
  samePrReviewInventories,
} from './same-pr-submission-fixture.ts'

const workflow = roxabiWorkflowFixtures()

type ImplementResult = Extract<CanonicalRecord, { kind: 'action-receipt' }> & {
  payload: Extract<
    Extract<CanonicalRecord, { kind: 'action-receipt' }>['payload'],
    { action: 'implement'; phase: 'result' }
  >
}

export interface SamePrCriterionFixtureOptions {
  mandate: MandateRecord
  effective: SpecEffective
  binding: CanonicalRecord
  pullRequest: Scope
  head: string
  prefix: string
}

export interface SamePrCriterionFixture {
  inputs: ActionInputs
  planRecords: CanonicalRecord[]
  implementationStart: ReceiptRecord
  implementationResult: ImplementResult
  authorityRecords: CanonicalRecord[]
  target: CriterionTarget
  declaration: CriterionDeclaration
  verdict: CriterionVerdict
  specRows: CriterionVerdict[]
}

/** The caller supplies the authenticated histories containing these records and the existing PR binding. */
export function createSamePrCriterionFixture(options: SamePrCriterionFixtureOptions): SamePrCriterionFixture {
  const { mandate, effective, binding, pullRequest, head, prefix } = options
  const uw = mandateScope(mandate)
  const own = effective.own
  if (canonicalValueDigest(own.uw) !== canonicalValueDigest(uw))
    throw new Error('effective Spec must belong to the execution mandate UW')
  if (!effective.spec.criteria.some((criterion) => criterion.id === 'C1'))
    throw new Error('effective Spec must contain C1')
  if (binding.repository !== pullRequest.repository || binding.target !== pullRequest.target)
    throw new Error('binding must belong to the supplied pull request')

  const planId = `${prefix}-plan`
  const reviewId = `${prefix}-plan-review`
  const implementId = `${prefix}-implement`
  const digest = workflow.publishedPlanDigest()
  const withEffectiveSpec = (inputs: ActionInputs): ActionInputs => {
    const manifest: ActionInputs['manifest'] = { ...inputs.manifest, spec: { kind: 'accepted', effective } }
    return { ...inputs, manifest, fingerprint: actionInputDigest(manifest) }
  }
  const planRecords = [
    ...workflow.planDraftRecords(mandate, planId, own.version),
    workflow.planReviewStart(mandate, planId, digest, reviewId, own.version),
    workflow.planReviewRecord(
      mandate,
      planId,
      digest,
      [
        workflow.clearPlanContribution('slot-architect', 'R-workflow-plan-architect'),
        workflow.clearPlanContribution('slot-adversarial', 'R-workflow-plan-adversarial'),
      ],
      reviewId,
      own.version,
    ),
  ].map((record) => ({ ...record, payload: { ...record.payload, inputs: withEffectiveSpec(record.payload.inputs) } }))
  const target = { format: FINDING_TARGET_FORMAT, kind: 'criterion' as const, spec: effective.own, id: 'C1' as const }
  const reason = 'No criterion evidence was supplied by this fixture.'
  const declaration = criterionDeclarationSchema.parse({ target, verification: 'unverified', reason })
  const verdict = criterionVerdictSchema.parse({
    target,
    verdict: 'unverified',
    criterionKind: 'behavior',
    bugRegression: false,
    restoration: 'not-applicable',
    examined: [],
    reason,
  })
  const initialStart = workflow.implementStart(mandate, implementId)
  const initialResult = workflow.rejectedImplementResult(mandate, implementId)
  if (
    initialStart.payload.action !== 'implement' ||
    initialStart.payload.phase !== 'start' ||
    initialResult.payload.action !== 'implement' ||
    initialResult.payload.phase !== 'result' ||
    initialResult.payload.structured === null ||
    !('commitSHAs' in initialResult.payload.structured) ||
    initialResult.payload.admission === null
  )
    throw new Error('expected implementation fixture records')
  const exactInputs = { ...initialStart.payload.exactInputs, planActionId: planId }
  const implementationStart = {
    ...initialStart,
    payload: { ...initialStart.payload, exactInputs, inputs: withEffectiveSpec(initialStart.payload.inputs) },
  }
  const implementationResult: ImplementResult = {
    ...initialResult,
    payload: {
      ...initialResult.payload,
      exactInputs,
      inputs: withEffectiveSpec(initialResult.payload.inputs),
      structured: { ...initialResult.payload.structured, commitSHAs: [head], criteria: [declaration] },
      admission: {
        ...initialResult.payload.admission,
        admitted: true,
        commits: [head],
        remoteBranch: `fixture/${prefix}`,
        remoteTip: head,
        published: true,
        reason: 'Fixture implementation was published at the review head.',
      },
    },
  }
  const pin = (record: CanonicalRecord) => ({
    source: 'record' as const,
    record: {
      scope: { repository: record.repository, target: record.target },
      kind: record.kind,
      recordId: record.recordId,
    },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  })
  const base = acceptedActionInputs(mandate, 'review')
  const manifest: ActionInputs['manifest'] = {
    ...base.manifest,
    subject: { kind: 'uw', uw, pullRequest, binding: pin(binding) },
    spec: { kind: 'accepted', effective },
    code: { ...base.manifest.code, repository: uw.repository, head },
    deliveryData: [
      {
        source: 'record',
        role: 'implementation',
        record: { scope: uw, kind: 'action-receipt', recordId: implementationResult.recordId },
        selector: '/payload/structured/criteria/0',
        digest: canonicalValueDigest(declaration),
      },
    ],
  }
  const inputs: ActionInputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
  return {
    inputs,
    planRecords,
    implementationStart,
    implementationResult,
    authorityRecords: [...planRecords, implementationStart, implementationResult],
    target,
    declaration,
    verdict,
    specRows: [verdict],
  }
}

/** Replace one fixture review graph without changing its record or operation identities. */
export function attachSamePrCriterionReview(
  history: DecodedHistory,
  reviewId: string,
  inputs: ActionInputs,
  verdict: CriterionVerdict,
): DecodedHistory {
  const records = history.operations.flatMap((entry) => (entry.record === null ? [] : [entry.record]))
  const review = records.find((record) => record.recordId === reviewId)
  if (review?.kind !== 'review') throw new Error('review fixture not found')
  const { root, synthesis } = samePrReviewInventories(records, review)
  const decision = records.find((record) => record.recordId === review.payload.decisionId)
  if (decision?.kind !== 'decision' || decision.payload.judgment.purpose !== 'review')
    throw new Error('expected review decision')
  const source = records.filter(
    (record) =>
      record.kind === 'contribution' && decision.payload.judgment.sourceContributionIds.includes(record.recordId),
  )
  const spec = source.find((record) => record.kind === 'contribution' && record.payload.host.phase === 'spec')
  const synthesisContribution = records.find((record) => record.recordId === decision.payload.originalContributionId)
  if (spec?.kind !== 'contribution' || synthesisContribution?.kind !== 'contribution')
    throw new Error('expected spec and synthesis contributions')
  const digest = actionInputDigest(inputs.manifest)
  if (inputs.fingerprint !== digest) throw new Error('review input fingerprint does not match manifest')
  const actions = new Map(
    root.payload.slots.map((slot) => [
      slot.slotId,
      { actionId: slot.action?.actionId ?? `${root.recordId}-${slot.slotId}`, inputs },
    ]),
  )
  const specSlot = root.payload.slots.find((slot) => slot.phase === 'spec')
  if (specSlot === undefined || spec.payload.host.slotId !== specSlot.slotId)
    throw new Error('spec contribution must match an allocated spec slot')
  const judgment = {
    ...decision.payload.judgment,
    criterionVerdicts: [{ contributionId: spec.recordId, target: verdict.target }],
  }
  const specOutput = { findings: [], specRows: [verdict] }
  const replacements = new Map<string, CanonicalRecord>()
  const replace = (record: unknown) => {
    const parsed = parseRecord(record)
    if (!parsed.ok) throw new Error(`invalid review fixture record: ${JSON.stringify(parsed.diagnostics)}`)
    replacements.set(parsed.value.recordId, parsed.value)
  }
  replace({
    ...root,
    payload: {
      ...root.payload,
      candidateGitSHA: inputs.manifest.code.head,
      input: digest,
      actionInputDigest: digest,
      inputSnapshot: inputs,
      slots: root.payload.slots.map((slot) => ({
        ...slot,
        ...(slot.slotId === specSlot.slotId ? { role: 'R-review-spec' } : {}),
        action: actions.get(slot.slotId),
      })),
    },
  })
  replace({
    ...synthesis,
    payload: {
      ...synthesis.payload,
      candidateGitSHA: inputs.manifest.code.head,
      input: digest,
      actionInputDigest: digest,
      slots: synthesis.payload.slots.map((slot) => ({
        ...slot,
        action: { actionId: slot.action?.actionId ?? synthesis.recordId, inputs },
      })),
    },
  })
  replaceSamePrSourceContributions(source, actions, spec.recordId, specOutput, replace)
  replace({ ...decision, payload: { ...decision.payload, judgment } })
  replace({
    ...synthesisContribution,
    payload: {
      ...synthesisContribution.payload,
      structured: judgment,
      rawAttempts: captureSamePrSubmission(synthesisContribution.payload.rawAttempts, judgment),
    },
  })
  replace({ ...review, payload: { ...review.payload, candidateGitSHA: inputs.manifest.code.head, input: digest } })
  return {
    ...history,
    operations: history.operations.map((entry) => ({
      ...entry,
      record: entry.record === null ? null : (replacements.get(entry.record.recordId) ?? entry.record),
    })),
  }
}
