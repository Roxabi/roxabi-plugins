import { canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import { evidenceDigest } from '../engine/criterion-admission.ts'
import { criterionEvidenceSchema, type ObservationRef } from '../engine/criterion-evidence-schema.ts'
import { criterionVerdictSchema } from '../engine/criterion-verdict-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { type MandateRecord, mandateScope } from '../engine/workflow-control.ts'
import { submission } from './record-builders.ts'
import { contribution } from './record-decisions.ts'
import { epicReviewGraph } from './record-graphs.ts'

/** Construct an epic-range review against the parent's own accepted C1 and candidate. */
export function criterionEpicReviewGraph(options: {
  mandate: MandateRecord
  inputs: ActionInputs
  head: string
  range: string
  issueRecords: readonly CanonicalRecord[]
  coverageReferences: readonly ObservationRef[]
  prefix?: string
  blocking?: boolean
}) {
  const { mandate, head, range, inputs, issueRecords } = options
  const integrationPins = inputs.manifest.deliveryData.filter((ref) => ref.role === 'integration')
  const integrationPin = integrationPins[0]
  const implementationPin = inputs.manifest.deliveryData.find(
    (ref) => ref.role === 'implementation' && ref.record.recordId === integrationPin?.record.recordId,
  )
  const integration = issueRecords.find(
    (record) =>
      integrationPin !== undefined &&
      record.kind === 'action-receipt' &&
      record.recordId === integrationPin.record.recordId &&
      record.repository === integrationPin.record.scope.repository &&
      record.target === integrationPin.record.scope.target,
  )
  if (
    integration?.kind !== 'action-receipt' ||
    integration.payload.action !== 'integrate' ||
    integration.payload.phase !== 'result' ||
    integration.payload.admission?.admitted !== true ||
    integrationPins.length !== 1 ||
    integration.payload.structured?.outcome !== 'integrated' ||
    integrationPin?.selector !== '/payload/structured/code' ||
    integrationPin.record.kind !== 'action-receipt' ||
    integrationPin.digest !== canonicalValueDigest(integration.payload.structured.code) ||
    integration.repository !== mandate.repository ||
    integration.target !== mandate.target ||
    integration.payload.structured.code.repository !== inputs.manifest.code.repository ||
    integration.payload.structured.code.base !== inputs.manifest.code.base ||
    integration.payload.structured.code.head !== inputs.manifest.code.head ||
    inputs.manifest.code.head !== head ||
    inputs.manifest.code.referenceCommit !== head ||
    integration.payload.structured.code.referenceCommit !== integration.payload.inputs.manifest.code.referenceCommit ||
    integration.payload.inputs.manifest.code.referenceCommit !== integration.payload.inputs.manifest.code.head ||
    integration.payload.admission.remoteTip !== head ||
    implementationPin?.record.recordId !== integration.recordId ||
    implementationPin.record.scope.repository !== integration.repository ||
    implementationPin.record.scope.target !== integration.target ||
    options.coverageReferences.length === 0
  )
    throw new Error('Expected actual admitted integration and coverage references in captured review inputs')
  if (inputs.manifest.spec.kind !== 'accepted') throw new Error('Expected accepted parent Spec')
  const effective = inputs.manifest.spec.effective
  const expectedCriteria = new Set(effective.spec.criteria.map((criterion) => criterion.id))
  const actualCriteria = integration.payload.structured.criteria.map((declaration) => declaration.target.id)
  if (
    expectedCriteria.size === 0 ||
    actualCriteria.length !== expectedCriteria.size ||
    new Set(actualCriteria).size !== actualCriteria.length ||
    actualCriteria.some((id) => !expectedCriteria.has(id))
  )
    throw new Error('Integration does not contain every accepted own criterion exactly once')
  const rows = integration.payload.structured.criteria.map((declaration, index) => {
    const candidates = inputs.manifest.deliveryData.filter(
      (ref) =>
        ref.role === 'implementation' &&
        ref.record.recordId === integration.recordId &&
        ref.record.kind === 'action-receipt' &&
        ref.record.scope.repository === integration.repository &&
        ref.record.scope.target === integration.target &&
        ref.selector === `/payload/structured/criteria/${index}`,
    )
    const selection = candidates[0]
    if (
      candidates.length !== 1 ||
      !selection ||
      selection.digest !== canonicalValueDigest(declaration) ||
      declaration.verification !== 'evidence' ||
      declaration.evidence.length !== 1 ||
      canonicalValueDigest(declaration.target.spec) !== canonicalValueDigest(effective.own)
    )
      throw new Error('Expected the exact parent criterion evidence pin')
    const parsed = criterionEvidenceSchema.safeParse(declaration.evidence[0])
    if (
      !parsed.success ||
      parsed.data.method !== 'test' ||
      canonicalValueDigest(parsed.data.target) !== canonicalValueDigest(declaration.target) ||
      parsed.data.code.repository !== inputs.manifest.code.repository ||
      parsed.data.code.commit !== head
    )
      throw new Error('Expected captured parent test evidence at the reviewed head')
    const evidence = parsed.data
    return criterionVerdictSchema.parse({
      target: declaration.target,
      verdict: 'satisfied',
      criterionKind: 'behavior',
      bugRegression: false,
      restoration: 'not-applicable',
      examined: [
        {
          evidence: { receipt: selection.record, evidenceId: evidence.id, digest: evidenceDigest(evidence) },
          truth: 'supported',
          applicability: 'applies',
          codeLink: {
            method: 'test',
            after: {
              support: 'supported',
              reason: 'Captured parent test and assignments',
              references: [...options.coverageReferences],
            },
            before: null,
          },
          reason: 'The captured result supports the criterion',
        },
      ],
      reason: 'Independent fixture review supports the parent criterion',
    })
  })
  if (rows.length === 0) throw new Error('Expected direct parent criteria')
  const scope = mandateScope(mandate)
  const graph = epicReviewGraph({ prefix: options.prefix, head, range, scope, inputs, empty: !options.blocking })
  const root = {
    ...graph.root,
    payload: {
      ...graph.root.payload,
      slots: graph.root.payload.slots.map((slot) =>
        slot.slotId === 'spec-0' ? { ...slot, role: 'R-review-spec' } : slot,
      ),
    },
  }
  const structured = { findings: [], specRows: rows }
  const spec = contribution({
    id: graph.spec.recordId,
    scope,
    inventoryId: root.recordId,
    phase: 'spec',
    role: 'R-review-spec',
    slotId: 'spec-0',
    chunk: null,
    findings: [],
    structured,
    rawAttempts: [
      submission({ id: `child-${graph.spec.recordId}`, structuredOutput: { status: 'valid', data: structured } }),
    ],
  })
  if (graph.decision.payload.judgment.purpose !== 'review') throw new Error('Expected review judgment')
  const judgment = {
    ...graph.decision.payload.judgment,
    criterionVerdicts: rows.map((row) => ({ contributionId: spec.recordId, target: row.target })),
  }
  const decision = { ...graph.decision, payload: { ...graph.decision.payload, judgment } }
  const synthesisContribution = contribution({
    id: graph.synthesisContribution.recordId,
    scope,
    inventoryId: graph.synthesis.recordId,
    phase: 'synthesis',
    role: 'R-synthesis',
    slotId: 'synthesis-0',
    chunk: null,
    content: 'decision',
    structured: judgment,
    rawAttempts: [
      submission({
        id: `child-${graph.synthesisContribution.recordId}`,
        structuredOutput: { status: 'valid', data: judgment },
      }),
    ],
  })
  const records: CanonicalRecord[] = [root, spec, graph.panel, graph.synthesis, synthesisContribution, decision]
  return { ...graph, inputs, issueRecords, root, spec, synthesisContribution, decision, records }
}
