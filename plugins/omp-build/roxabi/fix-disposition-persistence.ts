import {
  type CanonicalRecord,
  canonicalValueDigest,
  type DecodedHistory,
  type DispositionSource,
  type Json,
  type Scope,
} from '../dist/contracts.js'
import type { FixActionResult, FixIdentity } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import type { FixDispositionStore } from './fix-disposition-store.ts'
import { record } from './fix-records.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>

function decisionSourceScopes(
  source: Extract<DispositionSource, { kind: 'decision' }>,
  add: (scope: Scope) => void,
): void {
  for (const cause of source.decision.payload.judgment.causes)
    for (const judgment of Object.values(cause.judgment))
      for (const reference of judgment.references) if (reference.source === 'record') add(reference.record.scope)
}

export function dispositionSourceScopes(source: DispositionSource, add: (scope: Scope) => void): void {
  if (source.kind === 'decision') {
    decisionSourceScopes(source, add)
  } else {
    for (const contribution of source.contributions)
      add({ repository: contribution.repository, target: contribution.target })
  }
}

export async function saveDisposition(
  outcome: Disposition['payload'],
  original: Scope,
  identity: FixIdentity,
  store: FixDispositionStore,
  histories: readonly DecodedHistory[],
  operations: DecodedHistory['operations'],
): Promise<FixActionResult<Disposition>> {
  const digest = canonicalValueDigest({
    origin: outcome.origin,
    versionVector: outcome.basis.versionVector,
    subject: outcome.subject,
    previous: outcome.previous,
    adjudication: outcome.adjudication,
  } as Json)
  const id = `cause-disposition-${digest.slice(0, 32)}`
  const existing = operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.authority !== 'foreign' &&
      operation.record?.kind === 'cause-disposition' &&
      operation.record.repository === original.repository &&
      operation.record.target === original.target &&
      (operation.record.recordId === id ||
        canonicalValueDigest(operation.record.payload as Json) === canonicalValueDigest(outcome as Json)),
  )?.record
  if (existing?.kind === 'cause-disposition') {
    if (canonicalValueDigest(existing.payload as Json) !== canonicalValueDigest(outcome as Json))
      return failure(`correction-disposition-conflict:${id}`)
    return { ok: true, value: existing }
  }
  try {
    const item = record(identity, original, 'cause-disposition', outcome as Json, [], id)
    if (item.kind !== 'cause-disposition') return failure(`correction-disposition-invalid:${id}`)
    const published = await store.publish(item, histories)
    if (published.status !== 'confirmed')
      return failure(`correction-disposition-unconfirmed:${id}`, ...published.diagnostics.map((entry) => entry.code))
    return { ok: true, value: item }
  } catch {
    return failure(`correction-disposition-unconfirmed:${id}`)
  }
}
