import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { fixtureReviewCatalogueReads } from '../../testing/action-input-fixtures.ts'
import { canonicalValueDigest } from '../action-input.ts'
import type { FixRecoveryObservation, FixRecoveryProposal, ScopeCut } from '../fix-recovery-control-schema.ts'
import { pinForComplete } from '../fix-recovery-discovery-records.ts'
import { commentAsPartPin } from '../fix-recovery-part-pins.ts'
import { fixRecoveryExpected } from '../fix-recovery-proposal.ts'
import type { FixOwnerSettledPayload } from '../fix-recovery-schema.ts'
import type { DecodedHistory } from '../history-schema.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Result } from '../result.ts'
import { scopeKey } from '../uw-graph.ts'
import { recoveryAssociationFixture } from './fix-recovery-association-fixture.ts'
import {
  correctionInputs,
  executableReview,
  foreignRecoveryContext,
  graphFacts,
  ownerAnchors,
  withObservedEvidence,
} from './fix-recovery-native-adoption-fixture.ts'

type Phase = 'close-predecision' | 'adopt-decision'
type Control = Extract<CanonicalRecord, { kind: 'fix-recovery' }>

export function required<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

function completePin<K extends CanonicalRecord['kind']>(history: DecodedHistory, kind: K, recordId: string) {
  const operation = history.operations.find((entry) => entry.recordId === recordId)
  const record = operation?.record
  if (operation?.status !== 'complete' || record?.kind !== kind) throw new Error(`Missing ${kind} ${recordId}`)
  return pinForComplete(
    { scope: history.source.scope, kind, recordId, operationId: record.operationId, runId: record.runId },
    record,
    operation,
  )
}

function historyCut(history: DecodedHistory): FixRecoveryObservation['histories'][number] {
  const { scope, expectedAuthor, stopAuthor, complete } = history.source
  if (!complete) throw new Error(`Incomplete history ${scope.target}`)
  const parts = history.operations
    .filter((operation) => operation.authority !== 'foreign')
    .flatMap((operation) => operation.parts)
    .map((comment) => {
      const pin = commentAsPartPin(comment)
      if (pin === null) throw new Error(`Unpinnable comment ${comment.locator}`)
      return pin
    })
  return { scope, expectedAuthor, stopAuthor, complete, parts }
}

function publicationCuts(histories: readonly DecodedHistory[], settlement: FixOwnerSettledPayload): ScopeCut[] {
  // Both phases have complete C0/R. Only the predecision close has a reserved, unsubmitted D.
  return histories.map(({ source: { scope } }) => ({
    scope,
    retiringOpened: settlement.opened,
    members: settlement.outbound
      .filter(({ identity }) => scopeKey(identity.scope) === scopeKey(scope))
      .sort((a, b) => compare(a.identity.kind, b.identity.kind))
      .map(({ identity, publication }) =>
        publication.state === 'confirmed'
          ? { disposition: 'keep-complete', record: publication.record }
          : { disposition: 'retire-incomplete', identity, observedParts: [] },
      ),
  }))
}

const date = '2026-10-27T12:00:00Z'

function frameAppender() {
  let serial = 95000
  return (history: DecodedHistory, record: CanonicalRecord, fragment = false) => {
    const bodies = required(encodeParts(record, '', 65_536))
    const body = bodies[0]
    if (!body) throw new Error(`Missing frame ${record.recordId}`)
    const parts = fragment
      ? (bodies.length > 1 ? bodies : required(encodeParts(record, '', Buffer.byteLength(body) - 1))).slice(0, 1)
      : bodies
    return decodeHistory({
      ...history.source,
      comments: [
        ...history.source.comments,
        ...parts.map((part) => {
          const nativeId = String(serial++)
          return {
            locator: `historical-recovery-${nativeId}`,
            nativeId,
            author: history.source.expectedAuthor,
            body: part,
            createdAt: date,
            updatedAt: date,
          }
        }),
      ],
    })
  }
}

/** Seed historical envelopes only; no preparation, publication, or simulated operator approval API. */
export async function historicalRecoveryFixture(
  phase: Phase,
  withExecutionEvidence = false,
  foreignExpansion?: 'pin-only' | 'finite-cut',
  catalogueDigest?: string,
) {
  const adoption = phase === 'adopt-decision'
  const fixture = await recoveryAssociationFixture(adoption && foreignExpansion === undefined)
  const { leaf, requestId, decisionId } = fixture
  const { input, prHistory } = fixture.observe({ review: adoption })
  const [originalHome] = input.histories
  if (!originalHome || input.graph.status !== 'complete') throw new Error('Missing historical recovery sources')
  const append = frameAppender()
  const expansion =
    foreignExpansion === undefined
      ? null
      : {
          ...executableReview(leaf, originalHome, prHistory, append),
          foreign: await foreignRecoveryContext(append, date),
        }
  const home = expansion?.home ?? originalHome
  const { common, host, runId, settledId, settlement } = ownerAnchors(home)
  const { uw, pullRequest, binding, mandate, destination } = common
  if (leaf.binding.kind !== 'workflow-binding') throw new Error('Missing historical workflow binding')
  const opened = settlement.opened
  const selectedDecision = expansion?.decision ?? leaf.review.decision
  const { pr, evidence } = withObservedEvidence(expansion?.pr ?? prHistory, append, {
    withExecutionEvidence,
    runId,
    decisionId: selectedDecision.recordId,
    uw,
  })
  const histories = [home, pr].sort((a, b) => compare(scopeKey(a.source.scope), scopeKey(b.source.scope)))
  const observedHistories =
    expansion !== null && foreignExpansion === 'finite-cut'
      ? [...histories, expansion.foreign.original].sort((a, b) =>
          compare(scopeKey(a.source.scope), scopeKey(b.source.scope)),
        )
      : histories
  const observation: FixRecoveryObservation = {
    format: 'omp-build-fix-recovery-observation/1',
    histories: observedHistories.map(historyCut),
    graph: graphFacts(input.graph),
    authority: {
      mandate: completePin(home, 'mandate', mandate.recordId),
      binding: completePin(pr, 'workflow-binding', binding.recordId),
      plugin: {
        ...common.plugin,
        files: [...common.plugin.files].sort((a, b) =>
          compare([a.repository, a.commit, a.path].join('\0'), [b.repository, b.commit, b.path].join('\0')),
        ),
      },
      configuration: common.configuration,
      accepted: common.accepted,
    },
    ...(adoption && {
      catalogues: fixtureReviewCatalogueReads().map(({ ref, contents }) => ({
        ref: catalogueDigest === undefined ? ref : { ...ref, digest: catalogueDigest },
        contents: new TextDecoder().decode(contents.value),
      })),
    }),
    pullRequest: {
      scope: pullRequest,
      state: 'open',
      candidateGitSHA: leaf.head,
      baseGitSHA: leaf.base,
      headRepository: destination.publicationRepository,
      branch: leaf.binding.payload.branch,
      base: leaf.binding.payload.base,
      destination,
    },
    local: { ...settlement.local, status: { format: 'git-status-porcelain-v1', stdout: '' } },
    host: {
      process: host.process,
      root: common.root,
      namespace: host.namespace,
      prior: { kind: 'sealed-drained-live' },
    },
  }
  const control = fixture.identity('fix-recovery', 'historical-control')
  const target = {
    opened,
    source: completePin(pr, 'contribution', fixture.sourceId.recordId),
    request: completePin(pr, 'fix-request', requestId.recordId),
  }
  const nativePreparation =
    expansion !== null
      ? {
          kind: 'prepared' as const,
          causeId: expansion.causeId,
          actionId: 'historical-native-correction',
          inputs: correctionInputs(leaf, expansion.decision, expansion.foreign.ref),
        }
      : { kind: 'no-native-action' as const }
  const phaseFacts = adoption
    ? ({
        phase: 'adopt-decision',
        target: { ...target, kind: 'decided', decision: completePin(pr, 'decision', selectedDecision.recordId) },
        claimReservation: fixture.identity('fix-owner', 'historical-adoption-claim', uw),
        nativePreparation,
      } as const)
    : ({
        phase: 'close-predecision',
        target: {
          ...target,
          kind: 'request-before-decision',
          decision: { state: 'not-submitted', reservation: decisionId },
        },
      } as const)
  const facts = {
    uw,
    pullRequest,
    binding,
    mandate,
    predecessor: null,
    opened,
    settled: { scope: uw, kind: 'fix-owner' as const, recordId: settledId },
    cuts: publicationCuts(histories, settlement),
    observation,
    observationDigest: canonicalValueDigest(observation),
    ...phaseFacts,
  }
  const proposal: FixRecoveryProposal = {
    format: 'omp-build-fix-recovery-proposal/1',
    operationId: control.operationId,
    control,
    expected: fixRecoveryExpected(observation),
    ...facts,
  }
  const proposalDigest = canonicalValueDigest(proposal)
  const record = required(
    buildRecord<'fix-recovery'>({
      ...pullRequest,
      kind: control.kind,
      version: 1,
      recordId: control.recordId,
      runId: control.runId,
      operationId: control.operationId,
      payload: {
        format: 'omp-build-fix-recovery/1',
        ...facts,
        proposalDigest,
        confirmation: {
          route: 'omp-native-command',
          operationId: control.operationId,
          proposalDigest,
          confirmedAt: date,
        },
      },
    }),
  )
  const lateDecision = required(
    parseRecord({
      ...selectedDecision,
      recordId: decisionId.recordId,
      operationId: decisionId.operationId,
      runId: decisionId.runId,
    }),
  )
  return {
    home,
    record,
    evidence,
    requestId: requestId.recordId,
    decisionId: adoption ? selectedDecision.recordId : decisionId.recordId,
    withLateDecisionFragment: (history: DecodedHistory) => append(history, lateDecision, true),
    readBack: (candidate: Control = record) => append(pr, candidate),
    foreign: expansion?.foreign ?? null,
    readBackWithForeignExpansion: (version: 'current' | 'changed') => {
      if (expansion === null) throw new Error('Expected a foreign expansion fixture')
      return expansion.foreign.observe(append(pr, record), record, version)
    },
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
