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

it.each(['assess-spec', 'attribute-ci'] as const)('%s context negative blocks only its own mandate', async (action) => {
  const fixture = receiptFixtures()
  const payload = (
    action === 'assess-spec'
      ? fixture.assessment.start.payload
      : fixture.payloads.find((entry) => entry.action === action && entry.phase === 'start')
  ) as ActionReceiptPayload | undefined
  if (payload?.phase !== 'start') throw new Error('missing start')
  const start = buildRecord({
    ...scope,
    version: 1,
    recordId: `${action}-context-start`,
    runId: 'run-1',
    operationId: `${action}-context-start-op`,
    kind: 'action-receipt',
    payload,
  })
  if (!start.ok) throw new Error(JSON.stringify(start.diagnostics))
  const result = buildRecord({
    ...scope,
    version: 1,
    recordId: `${action}-context-result`,
    runId: 'run-1',
    operationId: `${action}-context-result-op`,
    kind: 'action-receipt',
    payload: {
      ...payload,
      phase: 'result',
      start: { scope, recordId: start.value.recordId, kind: 'action-receipt' },
      native: { completion: 'completed', strict: 'valid', raw: null },
      structured: {
        outcome: 'missing-context',
        missing: [
          { locator: { kind: 'information-request', description: 'Policy' }, reason: 'Unavailable', targets: [] },
        ],
      },
      admission: null,
      diagnostics: [],
    } as ActionReceiptPayload,
  })
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  const predecessor = { scope, recordId: mandate.recordId, kind: 'mandate' as const }
  const abandoned = buildRecord({
    ...scope,
    version: 1,
    recordId: 'abandon-mandate',
    runId: 'run-1',
    operationId: 'op-abandon-mandate',
    kind: 'operator-control',
    payload: { control: 'abandon', controlId: 'abandon-mandate', mandate: predecessor, predecessor: null },
  })
  const successor = buildRecord({
    ...mandate,
    recordId: 'new-mandate',
    runId: 'run-2',
    operationId: 'op-new-mandate',
    payload: { ...mandate.payload, antecedent: predecessor },
  })
  if (!abandoned.ok || !successor.ok || successor.value.kind !== 'mandate') throw new Error('Invalid successor')
  const current = successor.value
  const currentRef = { scope, recordId: current.recordId, kind: 'mandate' as const }
  const selected = buildRecord({
    ...scope,
    version: 1,
    recordId: 'select-mandate',
    runId: 'run-2',
    operationId: 'op-select-mandate',
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId: 'select-mandate',
      mandate: currentRef,
      predecessor,
      successor: currentRef,
    },
  })
  if (!selected.ok) throw new Error('Invalid successor selection')
  const issue = workflow.historyFrom([mandate, start.value, result.value, abandoned.value, current, selected.value])
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
  const evidence = { issue, pullRequest: null, parents: [], causal }
  const own = actionCompletion(action, evidence, decisions(), mandate)
  expect(own.evidence.map((entry) => entry.code)).toContain('action-context-missing')
  const next = actionCompletion(action, evidence, decisions(), current)
  expect(next.status).toBe('not-started')
})
