import { observeHistoricalPins } from '../../adapters/github/historical-pins.ts'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../../adapters/github/transport.ts'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { criterionDispositionRecords } from '../../testing/criterion-dispositions.ts'
import { submission } from '../../testing/record-builders.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { actionInputDigest, canonicalValueDigest } from '../action-input.ts'
import type { RecordInputRef } from '../action-input-refs.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import type { FixRecoveryObservation } from '../fix-recovery-control-schema.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Scope } from '../record-values.ts'
import type { Result } from '../result.ts'
import { validateDecisionBindings } from '../review-decision.ts'
import type { UwGraphObservation } from '../uw-graph.ts'
import type { MandateRecord } from '../workflow-control.ts'

type Decision = Extract<CanonicalRecord, { kind: 'decision' }>
type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Review = Extract<CanonicalRecord, { kind: 'review' }>
type Leaf = {
  inputs: ActionInputs
  observation: { graph: UwGraphObservation }
  review: { decision: Decision; panel: Contribution; synthesisContribution: Contribution; review: Review }
}
type Append = (history: DecodedHistory, record: CanonicalRecord) => DecodedHistory

function must<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

function without(history: DecodedHistory, recordIds: readonly string[]) {
  const omitted = new Set(
    history.operations.flatMap((operation) =>
      operation.recordId !== null && recordIds.includes(operation.recordId) ? operation.parts : [],
    ),
  )
  return decodeHistory({ ...history.source, comments: history.source.comments.filter((part) => !omitted.has(part)) })
}

/** Replace the review's provisional cause with one mechanically supported by its own panel finding. */
export function executableReview(leaf: Leaf, home: DecodedHistory, pr: DecodedHistory, append: Append) {
  const { decision: previous, panel, synthesisContribution } = leaf.review
  const judgment = previous.payload.judgment
  const cause = judgment.causes[0]
  const finding = panel.payload.findings?.[0]
  if (judgment.purpose !== 'review' || !cause || !finding) throw new Error('Expected a blocking review finding')
  const reference: RecordInputRef = {
    source: 'record',
    record: { scope: pr.source.scope, kind: 'contribution', recordId: panel.recordId },
    selector: '/payload/findings/0',
    digest: canonicalValueDigest(finding),
  }
  const supported = (value: boolean, reason: string) => ({
    state: 'supported' as const,
    value,
    reason,
    references: [reference],
  })
  const corrected = {
    ...judgment,
    causes: [
      {
        ...cause,
        proposedDisposition: 'fix-original' as const,
        judgment: {
          necessary: supported(true, 'The panel reproduced stale data on save'),
          urgent: supported(true, 'Incorrect data persists on every save'),
          tooLarge: supported(false, 'The panel isolated the faulty save path'),
        },
      },
    ],
  }
  const decision = must(parseRecord({ ...previous, payload: { ...previous.payload, judgment: corrected } }))
  const source = must(
    parseRecord({
      ...synthesisContribution,
      payload: {
        ...synthesisContribution.payload,
        structured: corrected,
        rawAttempts: [
          submission({
            id: synthesisContribution.payload.host.childId,
            structuredOutput: { status: 'valid', data: corrected },
          }),
        ],
      },
    }),
  )
  if (decision.kind !== 'decision') throw new Error('Expected a canonical review decision')
  const updatedPr = append(append(without(pr, [previous.recordId, source.recordId]), source), decision)
  const refs = leaf.review.review.payload.causeDispositionRefs
  if (refs === undefined) throw new Error('Expected retained review dispositions')
  const prior = without(
    home,
    refs.map((ref) => ref.recordId),
  )
  const catalogues = fixtureReviewClassCatalogues()
  const bindings = validateDecisionBindings(decision, updatedPr, catalogues, [prior, updatedPr])
  if (!bindings.admissible) throw new Error(JSON.stringify(bindings.diagnostics))
  const { dispositions } = criterionDispositionRecords(
    leaf.inputs,
    decision,
    [prior, updatedPr],
    catalogues,
    leaf.observation.graph,
  )
  if (
    !dispositions.some(
      ({ payload: { outcome } }) => outcome.state === 'final' && outcome.disposition === 'fix-original',
    )
  )
    throw new Error(
      `Expected an executable review cause: ${JSON.stringify(dispositions.map(({ payload }) => payload))}`,
    )
  return { home: dispositions.reduce(append, prior), pr: updatedPr, decision, causeId: cause.id }
}

export async function foreignRecoveryContext(append: Append, controlTime: string) {
  const scope = { repository: 'acme/context', target: 'acme/context#42' }
  const workflow = roxabiWorkflowFixtures()
  const record = workflow.fixOnlyMandate(scope)
  const changed = workflow.fixOnlyMandate(scope, { branch: 'fix/rewritten-history' })
  const late = workflow.fixOnlyMandate(scope, {
    recordId: 'late-foreign-mandate',
    operationId: 'late-foreign-operation',
  })
  const empty = decodeHistory({
    scope,
    complete: true,
    expectedAuthor: 'operator',
    stopAuthor: null,
    diagnostics: [],
    comments: [],
  })
  const publishedLater = '2026-10-28T12:00:00Z'
  const dateParts = (history: DecodedHistory, timestamp: string, start = 0) =>
    decodeHistory({
      ...history.source,
      comments: history.source.comments.map((part, index) =>
        index < start ? part : { ...part, createdAt: timestamp, updatedAt: timestamp },
      ),
    })
  const seed = dateParts(append(empty, record), '2026-10-26T12:00:00Z')
  const encodeOptions = (history: DecodedHistory) => ({
    cwd: '.',
    readAuthor: 'operator',
    gh: async (_cwd: string, args: string[]) => {
      if (args[1] !== 'repos/acme/context/issues/42/comments?per_page=100&page=1')
        throw new Error(`Unexpected foreign history read: ${args.join(' ')}`)
      return JSON.stringify(
        history.source.comments.map((part) => ({
          id: part.nativeId,
          user: { login: part.author },
          body: part.body,
          created_at: part.createdAt,
          updated_at: part.updatedAt,
        })),
      )
    },
  })
  const original = decodeHistory(await readGitHubHistory(scope, encodeOptions(seed)))
  // Reuse the original native ID for the changed body. The late extra record has its own ID.
  const revised = append(empty, changed)
  const bad = decodeHistory({
    ...revised.source,
    comments: revised.source.comments.map((part, i) => ({ ...part, ...seed.source.comments[i], body: part.body })),
  })
  const versions = {
    current: dateParts(append(seed, late), publishedLater, seed.source.comments.length),
    changed: bad,
    absent: empty,
    'same-second': dateParts(seed, controlTime),
    'published-later': dateParts(seed, publishedLater),
  }
  const ref: RecordInputRef = {
    source: 'record',
    record: { scope, kind: 'mandate', recordId: record.recordId },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  }
  return {
    original,
    ref,
    observe: (pr: DecodedHistory, candidate: CanonicalRecord, version: keyof typeof versions) =>
      observeHistoricalPins(pr, encodeOptions(versions[version]), { candidate, includeHistory: false }),
  }
}

export function correctionInputs(
  leaf: { mandate: MandateRecord; inputs: ActionInputs; pullRequest: Scope },
  decision: Decision,
  ref: RecordInputRef,
): ActionInputs {
  const { mandate, inputs, pullRequest } = leaf
  const manifest = {
    ...inputs.manifest,
    purpose: 'correction' as const,
    configuration: {
      version: mandate.payload.config.version,
      digest: mandate.payload.config.digest,
      serialized: JSON.stringify(mandate.payload.config.effective),
    },
    expandedContext: [ref],
  }
  return {
    ...inputs,
    manifest,
    fingerprint: actionInputDigest(manifest),
    stageSources: [
      {
        source: 'record',
        record: { scope: pullRequest, kind: 'decision', recordId: decision.recordId },
        selector: '/payload',
        digest: canonicalValueDigest(decision.payload),
      },
    ],
  }
}

export function ownerAnchors(home: DecodedHistory) {
  const opening = home.operations.find(
    ({ record }) => record?.kind === 'fix-owner' && record.payload.phase === 'opened',
  )?.record
  const settled = home.operations.find(
    ({ record }) => record?.kind === 'fix-owner' && record.payload.phase === 'settled',
  )?.record
  if (
    opening?.kind !== 'fix-owner' ||
    opening.payload.phase !== 'opened' ||
    settled?.kind !== 'fix-owner' ||
    settled.payload.phase !== 'settled'
  ) {
    throw new Error('Missing historical owner anchors')
  }
  const { common } = opening.payload
  const { host } = common
  if (host.kind !== 'linux-qualified') throw new Error('Expected a qualified structural host')
  return { common, host, runId: opening.runId, settledId: settled.recordId, settlement: settled.payload }
}

export function graphFacts(
  graph: Extract<UwGraphObservation, { status: 'complete' }>,
): FixRecoveryObservation['graph'] {
  const { root, nodes } = graph
  const node = nodes[0]
  if (nodes.length !== 1 || !node) throw new Error('Expected a single UW in the recovery fixture')
  const { reference, body, bodySha256 } = node.raw
  return {
    root,
    nodes: [
      {
        uw: node.uw,
        title: node.title,
        raw: { reference, body, bodySha256 },
        labels: [...node.labels].sort(),
        wayfinderLabels: [...node.wayfinderLabels].sort(),
        parent: node.parent,
        children: [...node.children],
        blockers: [...node.blockers],
        native: node.native,
      },
    ],
  }
}

export function withObservedEvidence(
  history: DecodedHistory,
  append: Append,
  facts: { withExecutionEvidence: boolean; runId: string; decisionId: string; uw: Scope },
) {
  if (!facts.withExecutionEvidence) return { pr: history, evidence: null }
  // Evidence belongs to the control's finite observation, not to a later live read.
  const evidence = must(
    buildRecord({
      ...history.source.scope,
      version: 1,
      kind: 'correction-result',
      recordId: 'historical-apply-result',
      operationId: 'historical-apply-operation',
      runId: facts.runId,
      payload: {
        decisionId: facts.decisionId,
        causeDisposition: { scope: facts.uw, kind: 'cause-disposition', recordId: 'historical-disposition' },
        causeId: 'historical-cause',
        attempt: 1,
        outcome: 'failed',
        commitSHAs: [],
        raw: {},
      },
    }),
  )
  return { pr: append(history, evidence), evidence }
}
