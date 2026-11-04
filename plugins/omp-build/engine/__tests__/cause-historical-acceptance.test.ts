import { expect, it } from 'vitest'
import { authenticatedReview } from '../../testing/cause-input-fixture.ts'
import { submission } from '../../testing/record-builders.ts'
import { operation } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { assessCauseDispositions, validateCauseDispositionRecords } from '../cause-disposition.ts'
import { assessCauseHolds } from '../cause-hold.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from './workflow-spec-assessment-support.ts'
import { history, must } from './workflow-test-support.ts'

it.each(['editorial', 'material'] as const)(
  'authenticates a historical retained report after accepted %s Spec B',
  (classification) => {
    const { graph, context } = authenticatedReview()
    const fixtures = roxabiWorkflowFixtures()
    const mandate = fixtures.featureMandate(context.original, {
      recordId: 'mandate-42',
      body: 'Save the selected region',
    })
    const original = graph.panel.payload.findings?.[0]
    if (!original || original.data === null || typeof original.data !== 'object' || Array.isArray(original.data))
      throw new Error('Expected original finding')
    const data = { ...original.data, label: 'suggestion' }
    const output = { findings: [data] }
    const panel = must(
      parseRecord({
        ...graph.panel,
        payload: {
          ...graph.panel.payload,
          findings: [{ ...original, data }],
          structured: output,
          rawAttempts: [
            submission({ id: `child-${graph.panel.recordId}`, structuredOutput: { status: 'valid', data: output } }),
          ],
        },
      }),
    )
    if (panel.kind !== 'contribution') throw new Error('Expected contribution')
    const source = {
      ...graph.history,
      operations: graph.history.operations.map((entry) =>
        entry.recordId === panel.recordId ? operation(panel) : entry,
      ),
    }
    const initial = history([mandate])
    const assessed = must(
      assessCauseDispositions({
        context,
        source: { kind: 'retained-output', contributions: [panel], diagnostics: [] },
        histories: [initial, source],
        adjudications: [],
      }),
    )
    const payload = assessed.outcomes[0]
    if (!payload) throw new Error('Expected retained report')
    expect(payload.outcome).toMatchObject({ state: 'final', disposition: 'report', blocking: false })
    const report = must(
      buildRecord({
        version: 1,
        ...context.original,
        recordId: 'historical-report',
        runId: 'run',
        operationId: 'historical-report-op',
        kind: 'cause-disposition',
        payload,
      }),
    )
    const accepted = mandateAssessmentState(mandate)
    const next = proposedAssessmentState(accepted, { body: 'Editorial clarification of selected region' })
    const amendment = assessFixture(mandate, 'historical-amendment', accepted, next, classification)
    const control =
      classification === 'material' ? acceptMaterialFixture(mandate, 'accept-historical-material', amendment) : null
    const before = history([mandate, report])
    const after = history([mandate, report, amendment.start, amendment.result, ...(control ? [control] : [])])
    expect(resolveAcceptedSpec(mandate, [after])).toMatchObject({
      ok: true,
      spec: { ref: { sourceAccepted: { recordId: control?.recordId ?? amendment.result.recordId } } },
    })
    expect(validateCauseDispositionRecords({ records: [report], histories: [before, source] })).toEqual([])
    expect(validateCauseDispositionRecords({ records: [report], histories: [after, source] })).toEqual([])
    expect(
      assessCauseHolds({
        uw: context.original,
        histories: [after, source],
        graph: { status: 'complete', root: context.original, nodes: [], observedAt: '2026-10-27T12:00:00.000Z' },
      }),
    ).toEqual([])
    const forged = must(
      parseRecord({
        ...report,
        recordId: 'forged-historical-report',
        operationId: 'forged-op',
        payload: { ...report.payload, origin: { ...report.payload.origin, version: '0'.repeat(64) } },
      }),
    )
    expect(
      validateCauseDispositionRecords({
        records: [forged],
        histories: [
          history([mandate, forged, amendment.start, amendment.result, ...(control ? [control] : [])]),
          source,
        ],
      }).map((item) => item.code),
    ).toContain('cause-origin-unconfirmed')
  },
)
