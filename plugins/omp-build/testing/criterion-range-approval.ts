import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { type MandateRecord, mandateScope } from '../engine/workflow-control.ts'
import { criterionImplementationRecords, criterionSatisfiedRow } from './criterion-approval.ts'
import { submission } from './record-builders.ts'
import { contribution } from './record-decisions.ts'
import { epicReviewGraph } from './record-graphs.ts'

/** Construct an epic-range review against the parent's own accepted C1 and candidate. */
export function criterionEpicReviewGraph(options: {
  mandate: MandateRecord
  inputs: ActionInputs
  head: string
  range: string
  prefix?: string
  blocking?: boolean
}) {
  const { mandate, head, range } = options
  const issueRecords = criterionImplementationRecords(mandate, head)
  const implementation = issueRecords.find(
    (record) =>
      record.kind === 'action-receipt' && record.payload.action === 'implement' && record.payload.phase === 'result',
  )
  if (
    implementation?.kind !== 'action-receipt' ||
    implementation.payload.action !== 'implement' ||
    implementation.payload.phase !== 'result' ||
    implementation.payload.structured === null
  )
    throw new Error('Expected implementation result')
  const declaration = implementation.payload.structured.criteria[0]
  if (declaration === undefined) throw new Error('Expected implementation criterion declaration')
  const manifest = {
    ...options.inputs.manifest,
    deliveryData: [
      {
        source: 'record' as const,
        role: 'implementation' as const,
        record: { scope: mandateScope(mandate), recordId: implementation.recordId, kind: 'action-receipt' as const },
        selector: '/payload/structured/criteria/0',
        digest: canonicalValueDigest(declaration),
      },
    ],
  }
  const inputs = { ...options.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  const row = criterionSatisfiedRow({ mandate, inputs, head, issueRecords })
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
  const structured = { findings: [], specRows: [row] }
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
    criterionVerdicts: [{ contributionId: spec.recordId, target: row.target }],
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
