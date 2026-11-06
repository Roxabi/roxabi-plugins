import { createHash } from 'node:crypto'
import { decodeHistory } from '../adapters/github/history-codec.ts'
import { encodeParts } from '../adapters/github/history-encoder.ts'
import { rawSource } from '../adapters/github-native/uw-spec.ts'
import { actionInputDigest } from '../engine/action-input.ts'
import { assessCauseDispositions } from '../engine/cause-disposition.ts'
import { causeCreationProposalSchema } from '../engine/cause-disposition-schema.ts'
import { buildRecord, parseRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import { recordsOf } from '../engine/workflow-control.ts'
import { fixtureReviewClassCatalogues } from './action-input-fixtures.ts'
import { synthesisActionCapture } from './criterion-dispositions.ts'
import { submission } from './record-builders.ts'
import { acceptedPullRequestReviewGraph } from './record-graphs.ts'
import { operation as observedOperation } from './record-history.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'

const uw: Scope = { repository: 'acme/app', target: 'acme/app#42' }
const sister: Scope = { repository: 'acme/app', target: 'acme/app#43' }
const foreign: Scope = { repository: 'acme/app', target: 'acme/app#44' }
const now = '2026-10-27T12:00:00.000Z'
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fixtures = roxabiWorkflowFixtures()
const mandate = fixtures.featureMandate(uw, { recordId: 'mandate-42', body: 'Save the selected region' })

/** The declared native issue for the region fixture, independent of its mandate records. */
export function causeFixtureGraph(body = 'Save the selected region') {
  return {
    status: 'complete' as const,
    root: uw,
    observedAt: now,
    nodes: [
      {
        uw,
        title: 'Save region',
        raw: rawSource(uw.target, body, now),
        updatedAt: now,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: null,
        children: [],
        blockers: [],
        native: { state: 'OPEN' as const, stateReason: null },
      },
    ],
  }
}
const evidence = {
  source: 'git-file' as const,
  repository: uw.repository,
  commit: '1'.repeat(40),
  path: 'src/region.ts',
  digest: 'a'.repeat(64),
}
function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}
function ref<K extends CanonicalRecord>(record: K): { scope: Scope; recordId: string; kind: K['kind'] } {
  return {
    scope: { repository: record.repository, target: record.target },
    recordId: record.recordId,
    kind: record.kind,
  }
}
function framedHistory(scope: Scope, records: readonly CanonicalRecord[]) {
  const comments = records.flatMap((record) => must(encodeParts(must(parseRecord(record)), `# ${record.kind}`, 65536)))
  return decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    diagnostics: [],
    comments: comments.map((body, index) => ({
      locator: `comment-${index + 1}`,
      nativeId: String(index + 1),
      body,
      author: 'operator',
      createdAt: '2026-10-27T12:00:00Z',
      updatedAt: '2026-10-27T12:00:00Z',
    })),
  })
}
export function causeOriginalHistory(records: CanonicalRecord[] = []) {
  const initial = fixtures.historyFrom([mandate])
  return framedHistory(uw, [...recordsOf(initial), ...records])
}
export function authenticatedReview(sisterDisposition = false) {
  const binding = fixtures.workflowBinding(foreign, mandate, 'feat/42-save', 'main')
  if (binding.kind !== 'workflow-binding') throw new Error('Expected PR binding')
  const base = acceptedPullRequestReviewGraph({ mandate, binding, prefix: 'admission-source', label: 'issue' })
  const manifest = { ...base.inputs.manifest, repositoryReferences: [evidence] }
  const inputs = { ...base.inputs, manifest, fingerprint: actionInputDigest(manifest) }
  if (inputs.manifest.spec.kind !== 'accepted') throw new Error('Expected accepted Spec inputs')
  const generated = acceptedPullRequestReviewGraph({
    mandate,
    binding,
    prefix: 'admission-source',
    inputs,
    label: 'issue',
  })
  const decision = must(parseRecord(generated.decision))
  if (decision.kind !== 'decision') throw new Error('Expected review decision')
  const graph = { ...generated, decision, history: framedHistory(foreign, recordsOf(generated.history)) }
  const context = { original: uw, effective: inputs.manifest.spec.effective }
  if (!sisterDisposition) return { graph, context }
  const cause = graph.decision.payload.judgment.causes[0]
  if (!cause) throw new Error('Expected a review cause')
  const supported = (value: boolean) => ({
    state: 'supported' as const,
    value,
    reason: 'The selected source supports this judgment',
    references: [evidence],
  })
  const judgment = {
    ...graph.decision.payload.judgment,
    causes: [
      {
        ...cause,
        judgment: { necessary: supported(true), urgent: supported(true), tooLarge: supported(true) },
        proposedDisposition: 'sister-blocking' as const,
      },
    ],
  }
  const changedDecision = must(parseRecord({ ...graph.decision, payload: { ...graph.decision.payload, judgment } }))
  const changedSynthesis = must(
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
  if (changedDecision.kind !== 'decision' || changedSynthesis.kind !== 'contribution')
    throw new Error('Expected synthesis records')
  const updatedHistory = {
    ...graph.history,
    operations: graph.history.operations.map((item) => {
      if (item.recordId === changedDecision.recordId) return observedOperation(changedDecision)
      if (item.recordId === changedSynthesis.recordId) return observedOperation(changedSynthesis)
      return item
    }),
  }
  return {
    graph: { ...graph, decision: changedDecision, history: framedHistory(foreign, recordsOf(updatedHistory)) },
    context,
  }
}

export function sisterRecords() {
  const { graph, context } = authenticatedReview(true)
  const assessment = must(
    assessCauseDispositions({
      context,
      capture: synthesisActionCapture(graph.decision, [graph.history]),
      graph: causeFixtureGraph(),
      source: { kind: 'decision', decision: graph.decision },
      histories: [causeOriginalHistory(), graph.history],
      catalogues: fixtureReviewClassCatalogues(),
      adjudications: [],
    }),
  )
  const payload = assessment.outcomes.find(
    (item) =>
      item.subject.kind === 'cause' && item.outcome.state === 'final' && item.outcome.disposition === 'sister-blocking',
  )
  if (payload?.subject.kind !== 'cause') throw new Error('Expected an authenticated blocking sister')
  const held = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'sister-disposition',
      runId: 'run',
      operationId: 'sister-disposition-op',
      kind: 'cause-disposition',
      payload,
    }),
  )
  const proposedSpec = fixtures.childSnapshot(sister, 'Repair region persistence separately')
  const proposal = causeCreationProposalSchema.parse({
    format: 'omp-build-uw-proposal/1' as const,
    operationId: 'create-sister',
    operation: 'create' as const,
    target: { kind: 'create' as const, repository: uw.repository },
    expected: null,
    draft: {
      criteria: [{ kind: 'new' as const, draftKey: 'repair', statement: 'Repair region persistence separately' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    },
    allocation: {
      ledgerHead: null,
      assignments: [{ draftKey: 'repair', id: 'C1' as const }],
      retirements: [] as [],
      spec: proposedSpec.snapshot.spec,
    },
    renderedBody: 'Repair region persistence separately',
    title: 'Repair region persistence',
    factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
    tier: 'S' as const,
    tierOverride: null,
    writes: {
      labels: { add: [], remove: [] },
      relations: { addChildren: [], removeChildren: [], addBlockers: [], removeBlockers: [] },
    },
    normalization: [] as [],
    assessment: null,
    creation: {
      kind: 'sister' as const,
      disposition: ref(held),
      dispositionDigest: digest(held),
      original: uw,
      originalObservationDigest: 'b'.repeat(64),
      parent: null,
      parentObservation: null,
      relation: 'original-blocked-by-sister' as const,
    },
    parentAcceptance: null,
  })
  const proposalDigest = digest(proposal)
  const confirmation = {
    route: 'omp-native-command' as const,
    operationId: proposal.operationId,
    proposalDigest,
    confirmedAt: now,
  }
  const operation = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'create-intent',
      runId: 'run',
      operationId: 'create-intent-op',
      kind: 'cause-operation',
      payload: { format: 'omp-build-cause-operation/1', proposal, proposalDigest, confirmation },
    }),
  )
  const identity = must(
    buildRecord({
      version: 1,
      ...sister,
      recordId: 'sister-identity',
      runId: 'run',
      operationId: proposal.operationId,
      kind: 'spec-identity',
      payload: {
        format: 'omp-build-spec-identity/1',
        event: 'allocate',
        predecessor: null,
        proposalDigest,
        confirmation,
        allocations: proposal.allocation.assignments,
      },
    }),
  )
  const receipt = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'sister-receipt',
      runId: 'run',
      operationId: 'receipt-op',
      kind: 'debt-receipt',
      payload: {
        format: 'omp-build-debt-receipt/2',
        operation: ref(operation),
        disposition: ref(held),
        decision: payload.subject.decision,
        causeId: payload.subject.cause.id,
        original: uw,
        sister,
        parent: null,
        relation: 'original-blocked-by-sister',
        identity: ref(identity),
      },
    }),
  )
  return { graph, held, operation, identity, receipt }
}
