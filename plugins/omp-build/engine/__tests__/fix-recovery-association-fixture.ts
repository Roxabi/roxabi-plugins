import { createHash } from 'node:crypto'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { canonicalValueDigest } from '../action-input.ts'
import { parseRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { ObservedComment } from '../review-schema.ts'
import { associationFrames, associationSource } from './fix-recovery-association-source.ts'
import { buildDeliveredLeaf } from './uw-delivered-leaf-fixture.ts'

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: unknown }): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

/** Canonical frames and pins, not fabricated decoded operations or authority. */
export async function recoveryAssociationFixture(cleanReview = false) {
  const leaf = await buildDeliveredLeaf(cleanReview ? 'Approve (clean)' : 'Request changes')
  const { uw, pullRequest, mandate, binding, effective, head } = leaf
  const runId = 'recovery-association-run'
  const prefix = 'recovery-association'
  const identity = <K extends string>(kind: K, recordId: string, scope = pullRequest) => ({
    scope,
    kind,
    recordId,
    runId,
    operationId: `${prefix}-${recordId}`,
  })
  const owner = identity('fix-owner', 'owner', uw)
  const settlement = identity('fix-owner', 'settled', uw)
  const sourceId = identity('contribution', 'source')
  const requestId = identity('fix-request', 'request')
  const decisionId = identity('decision', 'decision')
  const opened = { scope: uw, kind: 'fix-owner' as const, recordId: owner.recordId }
  const { source, request } = associationSource({
    pullRequest,
    sourceId,
    requestId,
    runId,
    head,
    ownSpec: effective.own,
  })
  const frames = associationFrames()
  const sourceFrames = frames(source)
  const destination = {
    authority: 'github.com',
    publicationRepository: pullRequest.repository,
    destinationRef: 'refs/heads/feat/42-save',
  }
  const common = {
    owner,
    operationPrefix: prefix,
    host: {
      kind: 'linux-qualified',
      platform: 'linux',
      admission: {
        protocol: 'omp-build-destination-mutex/1',
        destinationDigest: canonicalValueDigest([
          destination.authority,
          destination.publicationRepository,
          destination.destinationRef,
        ]),
        namespace: { kind: 'linux-abstract', networkNamespace: 'network' },
      },
      process: {
        bootId: 'boot',
        userNamespace: 'user',
        pidNamespace: 'pid',
        effectiveUid: 1000,
        pid: 42,
        processStartTicks: '123',
      },
      namespace: {
        protocol: 'omp-build-execution/v1',
        bootId: 'boot',
        effectiveUid: 1000,
        userNamespace: 'user',
        pidNamespace: 'pid',
        mountNamespace: 'mount',
        networkNamespace: 'network',
        canonicalHostRoot: '/run/user/1000',
        rootDevice: '1',
        rootInode: '2',
        latchRootDevice: '1',
        latchRootInode: '3',
      },
    },
    root: { agentId: 'agent', registryGeneration: 1, sessionId: 'session', providerSessionId: 'provider' },
    destination,
    uw,
    pullRequest,
    writeScopes: [uw, pullRequest],
    mandate: { scope: uw, kind: 'mandate', recordId: mandate.recordId },
    binding: { scope: pullRequest, kind: 'workflow-binding', recordId: binding.recordId },
    plugin: leaf.inputs.manifest.plugin,
    configuration: {
      version: mandate.payload.config.version,
      digest: mandate.payload.config.digest,
      serialized: JSON.stringify(mandate.payload.config.effective),
    },
    accepted: effective,
    acceptedDigest: canonicalValueDigest(effective),
  }
  const reserve = (id: typeof sourceId | typeof requestId | typeof decisionId) => ({
    identity: id,
    publication: { state: 'reserved' },
  })
  const home = leaf.observation.histories.find((history) => history.source.scope.target === uw.target)
  const pr = leaf.observation.histories.find((history) => history.source.scope.target === pullRequest.target)
  function outboundPublications(
    options: { omit?: 'source' | 'request'; review?: boolean; decisions?: (typeof decisionId)[] },
    selectedSource: typeof sourceId,
    selectedRequest: typeof requestId,
    actualSourcePin: {
      identity: typeof sourceId
      envelopeDigest: string
      parts: (typeof sourceFrames)[number]['pin'][]
    },
    requestPin: { identity: typeof requestId; envelopeDigest: string; parts: (typeof sourceFrames)[number]['pin'][] },
  ) {
    return [
      ...(options.omit === 'source'
        ? []
        : [{ identity: selectedSource, publication: { state: 'confirmed', record: actualSourcePin } }]),
      ...(options.omit === 'request'
        ? []
        : [{ identity: selectedRequest, publication: { state: 'confirmed', record: requestPin } }]),
      ...(options.review ? [] : (options.decisions ?? [decisionId]).map(reserve)),
    ]
  }

  function scopedComments(
    target: string,
    source: typeof sourceId,
    request: typeof requestId,
    sourceComments: ObservedComment[],
    requestComments: ObservedComment[],
  ) {
    const comments: ObservedComment[] = []
    if (source.scope.target === target) comments.push(...sourceComments)
    if (request.scope.target === target) comments.push(...requestComments)
    return comments
  }

  function observe(
    options: {
      review?: boolean
      omit?: 'source' | 'request'
      sourceReservation?: typeof sourceId
      requestReservation?: typeof requestId
      decisions?: (typeof decisionId)[]
      extraRecords?: CanonicalRecord[]
    } = {},
  ) {
    if (!home || !pr) throw new Error('fixture histories missing')
    const selectedSource = options.sourceReservation ?? sourceId
    const selectedRequest = options.requestReservation ?? requestId
    const actualSource = must(
      parseRecord({
        ...source,
        ...selectedSource.scope,
        recordId: selectedSource.recordId,
        runId: selectedSource.runId,
        operationId: selectedSource.operationId,
      }),
    )
    const actualSourceFrames = selectedSource === sourceId ? sourceFrames : frames(actualSource)
    const actualSourcePin = {
      identity: selectedSource,
      envelopeDigest: canonicalValueDigest(actualSource),
      parts: actualSourceFrames.map((entry) => entry.pin),
    }
    const ordinaryRequest = request(options.review ? leaf.review.review.recordId : null)
    const r = must(
      parseRecord({
        ...ordinaryRequest,
        ...selectedRequest.scope,
        recordId: selectedRequest.recordId,
        runId: selectedRequest.runId,
        operationId: selectedRequest.operationId,
        payload: { ...ordinaryRequest.payload, requestContributionId: selectedSource.recordId },
        inputs: ordinaryRequest.inputs.map((id) => (id === sourceId.recordId ? selectedSource.recordId : id)),
      }),
    )
    if (r.kind !== 'fix-request') throw new Error('Expected canonical fix request')
    const requestFrames = frames(r)
    const requestPin = {
      identity: selectedRequest,
      envelopeDigest: canonicalValueDigest(r),
      parts: requestFrames.map((entry) => entry.pin),
    }
    const opening = must(
      parseRecord({
        ...uw,
        version: 1,
        kind: 'fix-owner',
        recordId: owner.recordId,
        runId,
        operationId: owner.operationId,
        inputs: [mandate.recordId],
        payload: {
          format: 'omp-build-fix-owner/1',
          phase: 'opened',
          common,
          intent: {
            kind: 'fresh-intake',
            afterClose: null,
            sourceReservation: selectedSource,
            requestReservation: selectedRequest,
          },
        },
      }),
    )
    const outbound = outboundPublications(options, selectedSource, selectedRequest, actualSourcePin, requestPin)
    const settled = must(
      parseRecord({
        ...uw,
        version: 1,
        kind: 'fix-owner',
        recordId: settlement.recordId,
        runId,
        operationId: settlement.operationId,
        inputs: [owner.recordId, ...(selectedSource.scope.target === uw.target ? [selectedSource.recordId] : [])],
        payload: {
          format: 'omp-build-fix-owner/1',
          phase: 'settled',
          opened,
          interrupted: {
            kind: 'publication-prefix',
            opened,
            source: { state: 'complete', record: actualSourcePin },
            request: { state: 'not-submitted', reservation: selectedRequest },
          },
          admissionSealed: true,
          outbound,
          witness: {
            kind: 'sealed-no-entry',
            hostContract: 'trusted-preparation/1',
            nativeAdmission: 'not-entered',
            correctionPlan: 'not-entered',
            driver: 'joined',
            publications: 'joined',
            git: 'joined',
            hostCallbacks: 'joined',
          },
          local: { head, remoteHead: head, statusDigest: createHash('sha256').update('').digest('hex'), clean: true },
        },
      }),
    )
    const extra = (options.extraRecords ?? []).flatMap((record) => frames(record).map((entry) => entry.comment))
    const sourceComments = actualSourceFrames.map((entry) => entry.comment)
    const requestComments = requestFrames.map((entry) => entry.comment)
    const homeHistory = decodeHistory({
      ...home.source,
      comments: [
        ...home.source.comments,
        ...scopedComments(uw.target, selectedSource, selectedRequest, sourceComments, requestComments),
        ...frames(opening).map((entry) => entry.comment),
        ...frames(settled).map((entry) => entry.comment),
      ],
    })
    const prHistory = decodeHistory({
      ...pr.source,
      comments: [
        ...pr.source.comments,
        ...scopedComments(pullRequest.target, selectedSource, selectedRequest, sourceComments, requestComments),
        ...extra,
      ],
    })
    return { input: { uw, graph: leaf.observation.graph, histories: [homeHistory, prHistory] }, request: r, prHistory }
  }
  return { leaf, identity, sourceId, requestId, decisionId, observe }
}
