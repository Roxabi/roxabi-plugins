import { createHash } from 'node:crypto'
import { encodeParts } from '../adapters/github/history-encoder.ts'
import { canonicalValueDigest } from '../dist/contracts.js'
import { buildRecord } from '../engine/record-construction.ts'
import { capturedSubmission } from '../roxabi/fix-contract.ts'
import { readFixRecoveryPrefixBootstrap } from './fix-recovery-prefix-bootstrap.ts'
import { frameFixRecoveryFixture } from './fix-recovery-prefix-framing.ts'
import { publishFixRecoveryFixture } from './fix-recovery-prefix-publish.ts'
import type { Box } from './sandbox/sandbox-types.ts'

// Structural external history only, not genuine originating host authority or native approval.
export async function seedFixRecoveryPrefix(
  box: Box,
  cwd: string,
  mode: 'torn-source' | 'torn-request' = 'torn-source',
) {
  const { baseline, mandate, binding, receipt, head, spec } = readFixRecoveryPrefixBootstrap(box, cwd)
  const uw = { repository: 'acme/app', target: 'acme/app#42' }
  const pullRequest = { repository: 'acme/app', target: 'acme/app#7' }
  const runId = 'fix-prefix-run'
  const operationPrefix = 'fix-prefix-operation'
  const identity = (scope: typeof uw, kind: string, recordId: string) => ({
    scope,
    kind,
    runId,
    operationId: `${operationPrefix}-${recordId}`,
    recordId,
  })
  const owner = identity(uw, 'fix-owner', 'fix-prefix-open')
  const source = identity(pullRequest, 'contribution', 'fix-prefix-source')
  const request = identity(pullRequest, 'fix-request', 'fix-prefix-request')
  const settledIdentity = identity(uw, 'fix-owner', 'fix-prefix-settled')
  const opened = { scope: uw, kind: 'fix-owner', recordId: owner.recordId }
  const settled = { scope: uw, kind: 'fix-owner', recordId: settledIdentity.recordId }
  const mandateRef = { scope: uw, kind: 'mandate', recordId: mandate.recordId }
  const bindingRef = { scope: pullRequest, kind: 'workflow-binding', recordId: binding.recordId }
  const envelope = (id: typeof owner, payload: unknown, inputs: string[]) => ({
    ...id.scope,
    version: 1,
    recordId: id.recordId,
    runId: id.runId,
    operationId: id.operationId,
    inputs,
    kind: id.kind,
    payload,
  })
  const destination = {
    authority: 'github.com',
    publicationRepository: 'acme/app',
    destinationRef: 'refs/heads/feat/42-save',
  }
  const common = {
    owner,
    operationPrefix,
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
        namespace: { kind: 'linux-abstract', networkNamespace: 'network-fixture' },
      },
      process: {
        bootId: 'boot-fixture',
        userNamespace: 'user-fixture',
        pidNamespace: 'pid-fixture',
        effectiveUid: 1000,
        pid: 1234,
        processStartTicks: '12345',
      },
      namespace: {
        protocol: 'omp-build-execution/v1',
        bootId: 'boot-fixture',
        effectiveUid: 1000,
        userNamespace: 'user-fixture',
        pidNamespace: 'pid-fixture',
        mountNamespace: 'mount-fixture',
        networkNamespace: 'network-fixture',
        canonicalHostRoot: '/run/user/1000',
        rootDevice: '1',
        rootInode: '2',
        latchRootDevice: '1',
        latchRootInode: '3',
      },
    },
    root: {
      agentId: 'agent-fixture',
      registryGeneration: 1,
      sessionId: 'session-fixture',
      providerSessionId: 'provider-fixture',
    },
    destination,
    uw,
    pullRequest,
    writeScopes: [uw, pullRequest],
    mandate: mandateRef,
    binding: bindingRef,
    plugin: receipt.payload.inputs.manifest.plugin,
    configuration: {
      version: mandate.payload.config.version,
      digest: mandate.payload.config.digest,
      serialized: JSON.stringify(mandate.payload.config.effective),
    },
    accepted: spec.effective,
    acceptedDigest: canonicalValueDigest(spec.effective),
  }
  const sourceRecord = buildRecord({
    ...pullRequest,
    version: 1,
    recordId: source.recordId,
    runId,
    operationId: source.operationId,
    kind: 'contribution',
    payload: {
      content: 'operator-request',
      inventoryId: null,
      host: { origin: 'operator', phase: 'fix', role: 'operator', slotId: null, chunk: null, childId: null },
      rawAttempts: [
        capturedSubmission({
          operatorRequest: { request: 'correct the issue' },
          publishBinding: {
            pushUrl: box.origin,
            publicationRepository: 'acme/app',
            localBranch: 'feat/42-save',
            destinationRef: 'refs/heads/feat/42-save',
            localHead: head,
            expectedRemoteSHA: head,
            defaultBranch: 'main',
            observed: {
              target: pullRequest.target,
              baseRepository: 'acme/app',
              baseDefaultBranch: 'main',
              localRef: 'refs/heads/feat/42-save',
              localHead: head,
              pushUrl: box.origin,
              remoteRepository: 'acme/app',
              remoteDefaultBranch: 'main',
              remoteLine: `${head}\trefs/heads/feat/42-save`,
              pr: { headRefOid: head, headRefName: 'feat/42-save', headRepository: 'acme/app', baseRefName: 'main' },
            },
          },
          candidateGitSHA: head,
        }),
      ],
      native: null,
      structured: null,
      findings: null,
    },
  })
  if (!sourceRecord.ok) throw new Error('fixture-source-invalid')
  const framedSource = encodeParts(sourceRecord.value, '', 400)
  if (!framedSource.ok || framedSource.value.length < 2) throw new Error('fixture-source-not-multipart')
  const date = '2026-10-27T12:00:00Z'
  const makePart = (body: string, id: number, part: number, total: number) => ({
    locator: `${pullRequest.target}:comment:${id}`,
    nativeId: String(id),
    author: 'operator',
    createdAt: date,
    updatedAt: date,
    bodyDigest: createHash('sha256').update(body).digest('hex'),
    part,
    total,
  })
  const sourceParts = framedSource.value.map((body, index) =>
    makePart(body, 9001 + index, index + 1, framedSource.value.length),
  )
  const sourcePin = { identity: source, envelopeDigest: canonicalValueDigest(sourceRecord.value), parts: sourceParts }
  const requestRecord = buildRecord({
    ...pullRequest,
    version: 1,
    recordId: request.recordId,
    runId,
    operationId: request.operationId,
    kind: 'fix-request',
    payload: {
      requestContributionId: source.recordId,
      existingReviewId: null,
      scope: 'correct the issue',
      originalSpec: spec.effective.own,
      landing: false,
    },
  })
  if (!requestRecord.ok) throw new Error('fixture-request-invalid')
  // Explicitly reduced frame size for adapter qualification; not evidence of native 65536-byte reachability.
  const framedRequest = encodeParts(requestRecord.value, '', 400)
  if (!framedRequest.ok || framedRequest.value.length < 2) throw new Error('fixture-request-not-multipart')
  const body = framedSource.value[0]
  const requestBody = framedRequest.value[0]
  if (!body || !requestBody || !sourceParts[0]) throw new Error('fixture-part-missing')
  const part = sourceParts[0]
  const requestPart = makePart(requestBody, 19001, 1, framedRequest.value.length)
  const interrupted =
    mode === 'torn-source'
      ? {
          kind: 'publication-prefix',
          opened,
          source: { state: 'submitted-unconfirmed', reservation: source, observedParts: [part] },
          request: { state: 'not-submitted', reservation: request },
        }
      : {
          kind: 'publication-prefix',
          opened,
          source: { state: 'complete', record: sourcePin },
          request: { state: 'submitted-unconfirmed', reservation: request, observedParts: [requestPart] },
        }
  const outbound =
    mode === 'torn-source'
      ? [
          { identity: source, publication: { state: 'submitted-unconfirmed', observedParts: [part] } },
          { identity: request, publication: { state: 'reserved' } },
        ]
      : [
          { identity: source, publication: { state: 'confirmed', record: sourcePin } },
          { identity: request, publication: { state: 'submitted-unconfirmed', observedParts: [requestPart] } },
        ]
  const opening = envelope(
    owner,
    {
      format: 'omp-build-fix-owner/1',
      phase: 'opened',
      common,
      intent: { kind: 'fresh-intake', afterClose: null, sourceReservation: source, requestReservation: request },
    },
    [mandate.recordId],
  )
  const settlement = envelope(
    settledIdentity,
    {
      format: 'omp-build-fix-owner/1',
      phase: 'settled',
      opened,
      interrupted,
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
    [owner.recordId],
  )
  publishFixRecoveryFixture({ box, mode, opening, settlement, date, sourceParts: framedSource.value, requestBody })
  return {
    box,
    uw,
    pullRequest,
    source,
    request,
    opened,
    settled,
    mandateRef,
    bindingRef,
    interrupted,
    part,
    framedSource: framedSource.value,
    framedRequest: framedRequest.value,
    date,
    identity,
    envelope,
    frame: frameFixRecoveryFixture,
    baseline,
  }
}
