import { createHash } from 'node:crypto'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { authenticatedReview, causeFixtureGraph } from '../../testing/cause-input-fixture.ts'
import { synthesisActionCapture } from '../../testing/criterion-dispositions.ts'
import { submission } from '../../testing/record-builders.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { operation } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest } from '../action-input.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import { assessCauseDispositions, resolveCauseActionInputs } from '../cause-disposition.ts'
import { causeAdjudicationProposalSchema } from '../cause-disposition-schema.ts'
import type { CriterionVerdict } from '../criterion-verdict-schema.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { canonicalSpec } from '../uw-spec.ts'
import { recordsOf } from '../workflow-control.ts'
import { cataloguesForInputs, withPinnedCatalogue } from './cause-catalogue-fixture.ts'
import { appendAccountedRecords, ref } from './cause-hold-fixture.ts'
import { attachSamePrCriterionReview } from './same-pr-criterion-fixture.ts'
import { must } from './workflow-test-support.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function replaceLineageSources(history: DecodedHistory, replacements: readonly CanonicalRecord[]): DecodedHistory {
  const byId = new Map(replacements.map((record) => [record.recordId, record]))
  return {
    ...history,
    operations: history.operations.map((entry) => {
      const replacement = entry.recordId === null ? undefined : byId.get(entry.recordId)
      return replacement === undefined ? entry : operation(replacement)
    }),
  }
}

function lineageReviewSource(pluginCommit?: string, lineageHead?: string, capturedInputs?: ActionInputs) {
  const { graph: seed, context: seedContext } = authenticatedReview()
  const fixtures = roxabiWorkflowFixtures()
  const content = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: 'Save the selected region' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const body = renderIssueSpecBody(content, { complexity: 1 })
  const parsed = parseIssueSpecBody({
    uw: seedContext.original,
    raw: rawSource(seedContext.original.target, body, '2026-10-27T12:00:00.000Z'),
  })
  if (parsed.status !== 'conformant') throw new Error('Expected conformant native Spec A')
  const mandate = fixtures.featureMandate(seedContext.original, {
    recordId: 'mandate-42',
    body,
    ownSpec: fixtures.ownSpecFromSnapshot(seedContext.original, parsed.snapshot),
    ...(lineageHead === undefined ? {} : { lineageHead }),
  })
  const binding = fixtures.workflowBinding(seed.history.source.scope, mandate, 'feat/42-save', 'main')
  if (binding?.kind !== 'workflow-binding') throw new Error('Expected authenticated binding')
  const base = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'admission-source', label: 'issue' })
  const seedManifest = {
    ...base.inputs.manifest,
    repositoryReferences: seed.inputs.manifest.repositoryReferences,
    ...(pluginCommit === undefined
      ? {}
      : { plugin: { ...base.inputs.manifest.plugin, commit: pluginCommit, files: [] } }),
  }
  const graph = acceptedPullRequestReviewGraph({
    mandate,
    binding,
    prefix: 'admission-source',
    label: 'issue',
    inputs:
      capturedInputs ??
      withPinnedCatalogue({
        ...base.inputs,
        manifest: seedManifest,
        fingerprint: actionInputDigest(seedManifest),
      }),
  })
  if (graph.inputs.manifest.spec.kind !== 'accepted') throw new Error('Expected accepted Spec A inputs')
  const context = { original: seedContext.original, effective: graph.inputs.manifest.spec.effective }
  return { context, fixtures, mandate, graph, body }
}
/** Build the mandate and PR binding before any historical decision exists. */
export function lineageSeed(pluginCommit?: string, lineageHead?: string) {
  const seed = lineageReviewSource(pluginCommit, lineageHead)
  const binding = recordsOf(seed.graph.history).find((record) => record.kind === 'workflow-binding')
  if (binding?.kind !== 'workflow-binding') throw new Error('Expected native PR binding')
  const issue = seed.fixtures.historyFrom([seed.mandate])
  return { ...seed, binding, histories: [issue, seed.fixtures.historyFrom([binding], 'operator', 'operator', [issue])] }
}

export function lineageFixture(
  count: number,
  lastNonblocking: boolean,
  pluginCommit?: string,
  capture?: { inputs: ActionInputs; verdict: CriterionVerdict; authorityHistory: DecodedHistory; lineageHead: string },
) {
  const { context, fixtures, mandate, graph, body } = lineageReviewSource(
    pluginCommit,
    capture?.lineageHead,
    capture?.inputs,
  )
  const catalogues = cataloguesForInputs(capture?.inputs ?? graph.inputs)
  const sourceAction = { actionId: 'lineage-panel-action', inputs: graph.inputs }
  const root = must(
    parseRecord({
      ...graph.root,
      payload: {
        ...graph.root.payload,
        slots: graph.root.payload.slots.map((slot) =>
          slot.slotId === 'panel-0' ? { ...slot, action: sourceAction } : slot,
        ),
      },
    }),
  )
  const original = graph.panel.payload.findings?.[0]
  const final = graph.decision.payload.judgment.findings[0]
  const cause = graph.decision.payload.judgment.causes[0]
  if (!original || !final || !cause) throw new Error('Expected authenticated original and cause')
  const originals = Array.from({ length: count }, (_, index) => ({
    ...original,
    id: `${graph.panel.recordId}:f${index}`,
  }))
  const findings = originals.map((item, index) => ({
    ...final,
    id: `${final.id}-${index}`,
    label: lastNonblocking && index === count - 1 ? ('suggestion' as const) : final.label,
    sourceFindingIds: [item.id],
  }))
  const panelOutput = { findings: originals.map((item) => item.data) }
  const panel = must(
    parseRecord({
      ...graph.panel,
      payload: {
        ...graph.panel.payload,
        host: { ...graph.panel.payload.host, action: sourceAction },
        findings: originals,
        structured: panelOutput,
        rawAttempts: [
          submission({ id: `child-${graph.panel.recordId}`, structuredOutput: { status: 'valid', data: panelOutput } }),
        ],
      },
    }),
  )
  const judgment = {
    ...graph.decision.payload.judgment,
    findings,
    causes: [{ ...cause, findingIds: findings.map((item) => item.id) }],
  }
  let decision = must(parseRecord({ ...graph.decision, payload: { ...graph.decision.payload, judgment } }))
  const synthesis = must(
    parseRecord({
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        structured: judgment,
        rawAttempts: [
          submission({
            id: `child-${graph.synthesisContribution.recordId}`,
            structuredOutput: { status: 'valid', data: judgment },
          }),
        ],
      },
    }),
  )
  if (decision.kind !== 'decision') throw new Error('Expected decision')
  let source = replaceLineageSources(graph.history, [root, panel, decision, synthesis])
  if (capture) {
    source = attachSamePrCriterionReview(source, graph.review.recordId, capture.inputs, capture.verdict)
    const captured = recordsOf(source).find((record) => record.recordId === decision.recordId)
    if (captured?.kind !== 'decision') throw new Error('Expected captured A decision')
    decision = captured
  }
  let own = capture?.authorityHistory ?? fixtures.historyFrom([mandate])
  const inputs = must(resolveCauseActionInputs({ decision, history: source, context }))
  const citation = inputs.flatMap((input) => input.manifest.repositoryReferences)[0]
  if (!citation) throw new Error('Expected pinned evidence')
  const assess = (adjudications: Extract<CanonicalRecord, { kind: 'cause-operation' }>[]) =>
    must(
      assessCauseDispositions({
        context,
        capture: synthesisActionCapture(decision, [source]),
        graph: causeFixtureGraph(body),
        source: { kind: 'decision', decision },
        histories: [own, source],
        catalogues,
        adjudications,
      }),
    ).outcomes.find((item) => item.subject.kind === 'cause')
  const initial = assess([])
  if (initial?.outcome.state !== 'pending-blocking') throw new Error('Expected pending cause')
  const disposition = (id: string, payload: typeof initial) => {
    const record = must(
      buildRecord({
        version: 1,
        ...context.original,
        recordId: id,
        runId: 'lineage-run',
        operationId: `write-${id}`,
        kind: 'cause-disposition',
        payload,
      }),
    )
    if (record.kind !== 'cause-disposition') throw new Error('Expected disposition')
    own = appendAccountedRecords(own, [record])
    return record
  }
  let pending = disposition('lineage-initial', initial)
  const transitions: {
    pending: typeof pending
    operation: Extract<CanonicalRecord, { kind: 'cause-operation' }>
    next: typeof pending
  }[] = []
  function adjudicateFinding(index: number) {
    const finding = findings[index]
    if (!finding) throw new Error('Expected distinct finding')
    const proposal = causeAdjudicationProposalSchema.parse({
      format: 'omp-build-cause-adjudication-proposal/1',
      operationId: `adjudicate-${index}`,
      operation: 'adjudicate-cause',
      uw: context.original,
      pending: ref(pending),
      pendingDigest: digest(pending),
      rejectedFindingIds: [finding.id],
      judgment: null,
      reason: 'Pinned evidence contradicts this finding',
      references: [citation],
    })
    const proposalDigest = digest(proposal)
    const intent = must(
      buildRecord({
        version: 1,
        ...context.original,
        recordId: `lineage-operation-${index}`,
        runId: 'lineage-run',
        operationId: `write-operation-${index}`,
        kind: 'cause-operation',
        payload: {
          format: 'omp-build-cause-operation/1',
          proposal,
          proposalDigest,
          confirmation: {
            route: 'omp-native-command',
            operationId: proposal.operationId,
            proposalDigest,
            confirmedAt: '2026-10-27T12:00:00.000Z',
          },
        },
      }),
    )
    if (intent.kind !== 'cause-operation') throw new Error('Expected operation')
    own = appendAccountedRecords(own, [intent])
    const nextPayload = assess([intent])
    if (!nextPayload || nextPayload.previous?.recordId !== pending.recordId) throw new Error('Expected exact successor')
    const next = disposition(`lineage-disposition-${index}`, nextPayload)
    transitions.push({ pending, operation: intent, next })
    pending = next
  }
  const rejected = lastNonblocking ? count - 1 : count
  for (let index = 0; index < rejected; index++) adjudicateFinding(index)
  return { context, source, own, findings, transitions, pending, mandate, decision, inputs: graph.inputs, catalogues }
}
