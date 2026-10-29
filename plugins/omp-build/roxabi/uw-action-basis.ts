import { recordOperation } from '../adapters/github/record-integrity.ts'
import { canonicalValueDigest } from '../engine/action-input.ts'
import { actionInputsSchema } from '../engine/action-input-schema.ts'
import { criterionEvidenceSchema, type ObservationRef } from '../engine/criterion-evidence-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Json, Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import { bindExternalRef, recordsOf } from '../engine/workflow-control.ts'
import type { ActionSubject, DeliveryDataRef, RecordInputRef } from './uw-action-contract.ts'
import { type ActionFactSource, authenticate, readHistories } from './uw-action-observe.ts'
import { actionFailure, jsonPointer, sha256Bytes } from './uw-action-result.ts'
import { knownRoleSelector } from './uw-action-selection.ts'
import { readGitFileBytes } from './uw-git-bytes.ts'

/** Scoped to one observation cut; validation still runs for each selected reference. */
export type EvidenceObservation = {
  histories: Map<string, Promise<Result<DecodedHistory[]>>>
  files: Map<string, Promise<Result<Uint8Array>>>
}

export function createEvidenceObservation(): EvidenceObservation {
  return { histories: new Map(), files: new Map() }
}

export function seedEvidenceObservation(histories: readonly DecodedHistory[]): EvidenceObservation {
  const observation = createEvidenceObservation()
  for (const history of histories) {
    const scope = history.source.scope
    observation.histories.set(
      JSON.stringify([scope.repository, scope.target]),
      Promise.resolve({ ok: true, value: [history] }),
    )
  }
  return observation
}

export async function readSelectedRecord(
  ref: RecordInputRef,
  source: ActionFactSource,
  accounted = false,
  observation?: EvidenceObservation,
): Promise<Result<Json>> {
  if (!knownRoleSelector(ref.record.kind, ref.selector))
    return actionFailure('record-unreadable', 'Selector is not a known role pointer')
  const key = JSON.stringify([ref.record.scope.repository, ref.record.scope.target])
  let historyRead = observation?.histories.get(key)
  if (historyRead === undefined) {
    historyRead = readHistories([ref.record.scope], source)
    observation?.histories.set(key, historyRead)
  }
  const read = await historyRead
  if (!read.ok) return read
  const history = read.value.find(
    (item) =>
      item.source.scope.repository === ref.record.scope.repository &&
      item.source.scope.target === ref.record.scope.target,
  )
  if (history === undefined) return actionFailure('record-unreadable', 'Selected record scope was not read')
  const bound = bindExternalRef(ref.record, history)
  if (!bound.ok) return { ok: false, diagnostics: bound.diagnostics }
  // Accounted source material includes both conserved native authority classes.
  if (accounted) {
    const operation = recordOperation(read.value, bound.value)
    if (operation === null || operation.authority === 'foreign')
      return actionFailure('record-unreadable', 'Expanded record is not a conserved native operation')
  }
  const authenticated = authenticate(bound.value, read.value)
  if (!authenticated.ok) return authenticated
  const selected = jsonPointer(bound.value, ref.selector)
  if (!selected.ok) return selected
  if (canonicalValueDigest(selected.value) !== ref.digest)
    return actionFailure('action-input-stale', 'Selected record value digest changed')
  return selected
}

async function confirmBasisItem(
  item: ObservationRef,
  source: ActionFactSource,
  observation?: EvidenceObservation,
): Promise<Result<true>> {
  if (item.source === 'record') {
    const read = await readSelectedRecord(item, source, false, observation)
    if (!read.ok) return read
    return { ok: true, value: true }
  }
  const key = JSON.stringify([item.repository, item.commit, item.path])
  let fileRead = observation?.files.get(key)
  if (fileRead === undefined) {
    fileRead = readGitFileBytes({
      repository: item.repository,
      commit: item.commit,
      path: item.path,
      cwd: source.cwd,
      gh: source.gh,
    })
    observation?.files.set(key, fileRead)
  }
  const bytes = await fileRead
  if (!bytes.ok) return bytes
  if (sha256Bytes(bytes.value) !== item.digest)
    return actionFailure('action-input-stale', 'Execution basis bytes changed')
  return { ok: true, value: true }
}

async function confirmEvidence(
  ref: RecordInputRef,
  source: ActionFactSource,
  observation?: EvidenceObservation,
): Promise<Result<true>> {
  const selected = await readSelectedRecord(ref, source, false, observation)
  if (!selected.ok) return selected
  const evidence = criterionEvidenceSchema.safeParse(selected.value)
  if (!evidence.success) return actionFailure('record-unreadable', 'Criterion evidence is not the canonical schema')
  const basis =
    evidence.data.method === 'test'
      ? [...evidence.data.after.versionClaim.references, ...(evidence.data.before?.versionClaim.references ?? [])]
      : evidence.data.references
  for (const item of basis) {
    const confirmed = await confirmBasisItem(item, source, observation)
    if (!confirmed.ok) return confirmed
  }
  return { ok: true, value: true }
}

export async function resolveEvidenceBasis(
  refs: readonly DeliveryDataRef[],
  source: ActionFactSource,
  observation?: EvidenceObservation,
): Promise<Result<true>> {
  for (const ref of refs) {
    if (ref.role !== 'criterion-evidence') continue
    const confirmed = await confirmEvidence(ref, source, observation)
    if (!confirmed.ok) return confirmed
  }
  return { ok: true, value: true }
}

export async function boundReviewSubject(
  digest: string,
  source: ActionFactSource,
  scopes: readonly Scope[],
): Promise<Result<ActionSubject>> {
  const read = await readHistories(scopes, source)
  if (!read.ok) return read
  for (const history of read.value) {
    for (const record of recordsOf(history)) {
      if (record.kind !== 'review-attempt') continue
      const payload = record.payload as { input?: unknown; inputSnapshot?: unknown }
      const parsed = actionInputsSchema.safeParse(payload.inputSnapshot)
      if (!parsed.success || payload.input !== digest || parsed.data.fingerprint !== digest) continue
      return { ok: true, value: parsed.data.manifest.subject }
    }
  }
  return actionFailure('review-input-changed', 'Reviewed action inputs are absent from review history')
}
