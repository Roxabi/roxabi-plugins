import {
  authenticateIntegrationPin,
  bindExternalRef,
  canonicalValueDigest,
  historyFor,
  recordsOf,
} from '../dist/contracts.js'
import type { ActionSpecInput } from '../engine/action-input-schema.ts'
import type { CodeRange } from '../engine/code-range-schema.ts'
import type { Result } from '../engine/result.ts'
import type { UwResult } from '../engine/uw-diagnostics.ts'
import { acceptedChain } from './uw-action-accepted-state.ts'
import type { RecordInputRef, UwActionRequest } from './uw-action-contract.ts'
import { authenticate } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import { currentAccountedMandate, selectDeliveryData } from './uw-action-selection.ts'
import { integrationProofInputs } from './uw-action-stage-closure.ts'
import type { UwRead } from './uw-contract.ts'

type ParentIntegration = {
  source: RecordInputRef
  code: CodeRange
  spec: ActionSpecInput
  acceptedSources: readonly RecordInputRef[]
}
export type ParentIntegrationRead = UwResult<ParentIntegration | null>

function projectionActionId(histories: Parameters<typeof historyFor>[1]): string {
  const actionIds = new Set(
    histories.flatMap((item) =>
      recordsOf(item).flatMap((record) => (record.kind === 'action-receipt' ? [record.payload.actionId] : [])),
    ),
  )
  let selectionId = 'current-parent-integration-projection'
  while (actionIds.has(selectionId)) selectionId += ':read'
  return selectionId
}

function validateIntegrationSources(
  read: UwRead,
  source: RecordInputRef,
  histories: Parameters<typeof historyFor>[1],
): Result<void> {
  const proof = integrationProofInputs(read)
  if (!proof.ok) return proof
  const receiptHistory = historyFor(source.record.scope, histories)
  if (receiptHistory === null) return actionFailure('record-unreadable', 'Integration history is unavailable')
  const receipt = bindExternalRef(source.record, receiptHistory)
  if (!receipt.ok) return receipt
  if (
    receipt.value.kind !== 'action-receipt' ||
    receipt.value.payload.action !== 'integrate' ||
    receipt.value.payload.phase !== 'result'
  )
    return actionFailure('record-unreadable', 'Integration receipt is unreadable')
  const producer = receipt.value.payload.inputs
  const sameSet = (left: readonly RecordInputRef[], right: readonly RecordInputRef[]) =>
    left.length === right.length &&
    new Set(left.map(canonicalValueDigest)).size === left.length &&
    left.every((item) => right.some((other) => canonicalValueDigest(item) === canonicalValueDigest(other)))
  if (
    !sameSet(producer.manifest.acceptedSources, proof.value.acceptedSources) ||
    !sameSet(producer.stageSources, proof.value.stageSources)
  )
    return actionFailure('review-input-changed', 'Integration accepted metadata or child proof sources changed')
  return { ok: true, value: undefined }
}

/** Project only the admitted integration selected against this complete observation and observed head. */
function selectCurrentParentIntegration(read: UwRead, base: string, head: string): Result<ParentIntegration | null> {
  if (read.observation.status !== 'complete')
    return actionFailure('record-unreadable', 'Parent observation is incomplete')
  const { histories, catalogues } = read.observation
  const history = historyFor(read.uw, histories)
  if (history === null || !history.source.complete)
    return actionFailure('record-unreadable', 'Parent history is incomplete')
  const mandate = currentAccountedMandate(history)
  if (!mandate.ok) return mandate
  const selectionId = projectionActionId(histories)
  const subject = { kind: 'uw' as const, uw: read.uw, pullRequest: null, binding: null }
  const request: UwActionRequest = {
    actionId: selectionId,
    purpose: 'review',
    subject,
    code: { repository: read.uw.repository, base, head, referenceCommit: head },
    stageSources: [],
    expandedContext: [],
  }
  const config = {
    version: mandate.value.payload.config.version,
    digest: mandate.value.payload.config.digest,
    serialized: JSON.stringify(mandate.value.payload.config.effective),
  }
  const accepted = acceptedChain(request, histories, mandate, config, read.observation.graph)
  if (!accepted.ok) return accepted
  const selected = selectDeliveryData(
    request,
    mandate.value,
    histories,
    catalogues,
    read.observation,
    (record) => authenticate(record, histories),
    undefined,
    accepted.value.spec,
  )
  if (!selected.ok) {
    if (
      selected.diagnostics.length === 1 &&
      selected.diagnostics[0]?.code === 'action-input-missing' &&
      selected.diagnostics[0].message === 'No current eligible plan'
    )
      return { ok: true, value: null }
    return selected
  }
  const pins = selected.value.refs.filter(
    (ref) =>
      ref.role === 'integration' &&
      ref.record.scope.repository === read.uw.repository &&
      ref.record.scope.target === read.uw.target,
  )
  const pin = pins[0]
  if (pin === undefined) return { ok: true, value: null }
  if (pins.length !== 1) return actionFailure('action-input-cycle', 'Several current integration receipts are eligible')
  const { role: _role, ...source } = pin
  const verified = authenticateIntegrationPin(
    source,
    {
      subject,
      spec: accepted.value.spec,
      mandate: { scope: read.uw, kind: 'mandate', recordId: mandate.value.recordId },
    },
    histories,
  )
  if (!verified.ok) return verified
  const proof = validateIntegrationSources(read, source, histories)
  if (!proof.ok) return proof
  return {
    ok: true,
    value: {
      source,
      code: verified.value.output.code,
      spec: accepted.value.spec,
      acceptedSources: accepted.value.acceptedSources,
    },
  }
}

export function currentParentIntegration(read: UwRead, base: string, head: string): ParentIntegrationRead {
  const selected = selectCurrentParentIntegration(read, base, head)
  if (selected.ok) return selected
  return {
    ok: false,
    diagnostics: selected.diagnostics.map((item) => ({
      code: item.code,
      message: item.message,
      location: { kind: 'native' as const, uw: read.uw, connection: 'state' as const },
      related: [],
    })),
  }
}
