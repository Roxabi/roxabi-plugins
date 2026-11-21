import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { fixtureReviewCatalogueReads } from '../../testing/action-input-fixtures.ts'
import { canonicalValueDigest } from '../action-input.ts'
import {
  buildConfirmedFixRecoveryAdoption,
  buildConfirmedFixRecoveryClose,
  prepareFixRecoveryAdoption,
  prepareFixRecoveryClose,
} from '../fix-recovery-close.ts'
import { makeFixRecoveryObservation } from '../fix-recovery-observation.ts'
import { commentAsPartPin } from '../fix-recovery-part-pins.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { recoveryAssociationFixture } from './fix-recovery-association-fixture.ts'

function required<T>(result: { ok: true; value: T } | { ok: false; diagnostics: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

// These canonical framed histories simulate structural facts, not live host proof or UI confirmation.
const fixturePromise = recoveryAssociationFixture()

function withoutRecords(history: DecodedHistory, ids: string[]) {
  const removed = new Set(
    history.operations
      .filter((operation) => operation.recordId !== null && ids.includes(operation.recordId))
      .flatMap((operation) => operation.parts.map((part) => part.locator)),
  )
  return decodeHistory({
    ...history.source,
    comments: history.source.comments.filter((comment) => !removed.has(comment.locator)),
  })
}

function append(history: DecodedHistory, record: CanonicalRecord, serial: number) {
  const parts = required(encodeParts(record, '', 65536))
  return decodeHistory({
    ...history.source,
    comments: [
      ...history.source.comments,
      ...parts.map((body, index) => ({
        locator: `owner-admission-${serial + index}`,
        nativeId: String(serial + index),
        author: history.source.expectedAuthor,
        body,
        createdAt: '2026-10-27T12:00:00Z',
        updatedAt: '2026-10-27T12:00:00Z',
      })),
    ],
  })
}

function anchors(histories: readonly DecodedHistory[]) {
  const records = histories.flatMap((history) =>
    history.operations.flatMap((operation) => (operation.record ? [operation.record] : [])),
  )
  const opening = records.find((record) => record.kind === 'fix-owner' && record.payload.phase === 'opened')
  const settled = records.find((record) => record.kind === 'fix-owner' && record.payload.phase === 'settled')
  if (
    opening?.kind !== 'fix-owner' ||
    opening.payload.phase !== 'opened' ||
    settled?.kind !== 'fix-owner' ||
    settled.payload.phase !== 'settled'
  )
    throw new Error('Missing fixture owner anchors')
  return { opening: { ...opening, payload: opening.payload }, settled: { ...settled, payload: settled.payload } }
}

function inputFor(
  fixture: Awaited<typeof fixturePromise>,
  histories: readonly DecodedHistory[],
  intent: 'fresh' | 'recovery' | 'claim',
) {
  const { opening } = anchors(histories)
  return {
    uw: fixture.leaf.uw,
    pullRequest: fixture.leaf.pullRequest,
    destination: opening.payload.common.destination,
    graph: fixture.leaf.observation.graph,
    histories,
    effectiveHistories: histories,
    intent,
  }
}

function pin<K extends 'mandate' | 'workflow-binding'>(history: DecodedHistory, kind: K) {
  const found = history.operations.filter((operation) => operation.record?.kind === kind)
  const operation = found[0]
  const record = operation?.record
  if (found.length !== 1 || !record || record.kind !== kind) throw new Error(`Expected one ${kind}`)
  const parts = operation.parts
    .map((part) => {
      const value = commentAsPartPin(part)
      if (!value) throw new Error(`Unpinnable ${kind}`)
      return value
    })
    .sort((a, b) => a.part - b.part)
  return {
    identity: {
      scope: history.source.scope,
      kind,
      runId: record.runId,
      operationId: record.operationId,
      recordId: record.recordId,
    },
    envelopeDigest: canonicalValueDigest(record),
    parts,
  }
}

function observationFixture(fixture: Awaited<typeof fixturePromise>, review = false) {
  const observed = fixture.observe({ review })
  const histories = observed.input.histories
  const [home, pr] = histories
  if (!home || !pr) throw new Error('Missing fixture history')
  const { opening, settled } = anchors(histories)
  const common = opening.payload.common
  if (common.host.kind !== 'linux-qualified') throw new Error('Expected qualified simulated host')
  const binding = pr.operations.find((operation) => operation.record?.kind === 'workflow-binding')?.record
  if (binding?.kind !== 'workflow-binding') throw new Error('Missing fixture binding')
  const current = {
    authority: {
      mandate: pin(home, 'mandate'),
      binding: pin(pr, 'workflow-binding'),
      plugin: common.plugin,
      configuration: common.configuration,
      accepted: common.accepted,
    },
    pullRequest: {
      scope: common.pullRequest,
      state: 'open' as const,
      candidateGitSHA: fixture.leaf.head,
      baseGitSHA: fixture.leaf.base,
      headRepository: common.destination.publicationRepository,
      branch: binding.payload.branch,
      base: binding.payload.base,
      destination: common.destination,
    },
    local: { ...settled.payload.local, status: { format: 'git-status-porcelain-v1' as const, stdout: '' } },
    host: {
      process: common.host.process,
      root: common.root,
      namespace: common.host.namespace,
      prior: { kind: 'sealed-drained-live' as const },
    },
    ...(review
      ? {
          catalogues: fixtureReviewCatalogueReads().map((entry) => ({
            ref: entry.ref,
            contents: new TextDecoder().decode(entry.contents.value),
          })),
        }
      : {}),
  }
  const observation = required(
    makeFixRecoveryObservation({ histories, graph: fixture.leaf.observation.graph, current }),
  )
  return { opening, common, current, observation, histories, home, pr }
}

function closeFixture(fixture: Awaited<typeof fixturePromise>) {
  const { opening, common, observation, histories, home, pr } = observationFixture(fixture)
  const control = {
    scope: common.pullRequest,
    kind: 'fix-recovery' as const,
    runId: 'close-run',
    operationId: 'close-operation',
    recordId: 'close-control',
  }
  const prepared = required(prepareFixRecoveryClose({ control, observation, histories }))
  const confirmed = required(
    buildConfirmedFixRecoveryClose({
      prepared,
      fresh: prepared,
      histories,
      confirmation: {
        route: 'omp-native-command',
        operationId: control.operationId,
        proposalDigest: prepared.digest,
        confirmedAt: '2026-10-27T12:00:00Z',
      },
    }),
  )
  const closedHistories: [DecodedHistory, DecodedHistory] = [home, append(pr, confirmed, 95000)]
  return { opening, confirmed, histories: closedHistories }
}

async function adoptionClaimFixture() {
  const fixture = await recoveryAssociationFixture(true)
  const source = observationFixture(fixture, true)
  const control = {
    scope: source.common.pullRequest,
    kind: 'fix-recovery' as const,
    runId: 'adopt-run',
    operationId: 'adopt-operation',
    recordId: 'adopt-control',
  }
  const reservation = {
    scope: fixture.leaf.uw,
    kind: 'fix-owner' as const,
    runId: 'claim-run',
    operationId: 'claim-operation',
    recordId: 'claim-owner',
  }
  const nativePreparation = { kind: 'no-native-action' as const }
  const prepared = required(
    prepareFixRecoveryAdoption({
      control,
      claimReservation: reservation,
      observation: source.observation,
      histories: source.histories,
      graph: fixture.leaf.observation.graph,
      nativePreparation,
    }),
  )
  const confirmed = required(
    buildConfirmedFixRecoveryAdoption({
      prepared,
      fresh: prepared,
      histories: source.histories,
      graph: fixture.leaf.observation.graph,
      confirmation: {
        route: 'omp-native-command',
        operationId: control.operationId,
        proposalDigest: prepared.digest,
        confirmedAt: '2026-10-27T12:00:00Z',
      },
    }),
  )
  const histories: [DecodedHistory, DecodedHistory] = [source.home, append(source.pr, confirmed, 98000)]
  const base = inputFor(fixture, histories, 'claim')
  const claim = { reservation, current: source.current, nativePreparation }
  return { fixture, source, prepared, confirmed, histories, base, claim }
}

export {
  adoptionClaimFixture,
  anchors,
  append,
  closeFixture,
  fixturePromise,
  inputFor,
  observationFixture,
  required,
  withoutRecords,
}
