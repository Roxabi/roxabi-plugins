import { expect, it } from 'vitest'
import { observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { decisions, shippedFacts } from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { buildRecord } from '../record-construction.ts'
import { actionCompletion } from '../workflow-action-completion.ts'
import type { WorkflowGraphAction } from '../workflow-graph.ts'
import type { ActionReceiptPayload } from '../workflow-receipt-schema.ts'
import { fixtures as receiptFixtures } from './workflow-receipt-schema-parity-fixtures.ts'
import { shippedFeatureMandate } from './workflow-spec-assessment-support.ts'

const workflow = roxabiWorkflowFixtures()
const mandate = shippedFeatureMandate()
const scope = { repository: mandate.repository, target: mandate.target }

it.each(
  (
    [
      ['assess-spec', 'assess-spec'],
      ['attribute-ci', 'attribute-ci'],
    ] as const
  ).flatMap(([action, graph]) => [[action, graph, 'invalid'] as const, [action, graph, 'withheld'] as const]),
)(
  'retained %s %s action terminal (%s) blocks its graph selector',
  async (action, graphAction: WorkflowGraphAction, terminal) => {
    const fixture = receiptFixtures()
    let source = action === 'assess-spec' ? fixture.assessment.start : undefined
    if (action === 'attribute-ci') {
      const payload = fixture.payloads.find((entry) => entry.action === 'attribute-ci' && entry.phase === 'start')
      if (!payload) throw new Error('missing CI start fixture')
      const record = buildRecord({
        ...scope,
        version: 1,
        recordId: 'ci-start',
        runId: 'run-1',
        operationId: 'ci-start-op',
        kind: 'action-receipt',
        payload,
      })
      if (!record.ok) throw new Error(JSON.stringify(record.diagnostics))
      source = record.value
    }
    if (source?.kind !== 'action-receipt' || source.payload.phase !== 'start') throw new Error('missing start')
    const reason = terminal === 'withheld' ? 'action-uncertain' : `${action}-output-invalid`
    const payload = {
      ...source.payload,
      phase: 'result',
      start: { scope, recordId: source.recordId, kind: 'action-receipt' },
      native: { completion: 'completed', strict: terminal === 'withheld' ? 'valid' : 'invalid', raw: null },
      structured: null,
      admission: null,
      diagnostics: [{ code: reason, message: reason }],
    } as ActionReceiptPayload
    const result = buildRecord({
      ...scope,
      version: 1,
      recordId: `${action}-negative`,
      runId: 'run-1',
      operationId: `${action}-negative-op`,
      kind: 'action-receipt',
      payload,
    })
    if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
    const issue = workflow.historyFrom([mandate, source, result.value])
    const causal = await observeFixtureNativeWorld({
      root: scope,
      nodes: [
        {
          scope,
          title: 'Feature',
          body: mandate.payload.ownSpec.snapshot.raw.body,
          updatedAt: '2026-10-21T12:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [issue],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
    const facts =
      source.payload.action === 'assess-spec'
        ? {
            ...shippedFacts(mandate),
            currentSpec: source.payload.exactInputs.proposed,
            identityAllocations: source.payload.exactInputs.identityAllocations,
          }
        : source.payload.action === 'attribute-ci'
          ? {
              ...shippedFacts(mandate, {
                scope: source.payload.exactInputs.scope,
                head: source.payload.exactInputs.candidateGitSHA,
                base: 'main',
                associatedIssue: scope,
              }),
              candidateGitSHA: source.payload.exactInputs.candidateGitSHA,
              evidenceDigest: source.payload.exactInputs.evidenceDigest,
            }
          : shippedFacts(mandate)
    const completion = actionCompletion(
      graphAction,
      { issue, pullRequest: null, parents: [], causal },
      decisions(),
      mandate,
      facts,
    )
    expect(['blocked', 'uncertain']).toContain(completion.status)
  },
)
