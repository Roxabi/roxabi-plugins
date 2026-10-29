import type { Gh } from '../adapters/github/types.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Contracts, History } from './feature-engine.ts'
import {
  authorizeExpandedStart,
  hasExpandedStart,
  recheckExpandedStart,
  validateExpandedStartLive,
} from './feature-start-expansion.ts'

type StartRecord = Extract<CanonicalRecord, { kind: 'action-receipt' }>
type Checked = { ok: true } | { ok: false; reason: string }

export async function authorizeStartPublication(
  record: CanonicalRecord,
  contracts: Contracts,
  histories: readonly History[],
  cwd: string,
  gh: Gh,
): Promise<Checked> {
  if (record.kind !== 'action-receipt' || record.payload.phase !== 'start' || !hasExpandedStart(record.payload))
    return { ok: true }
  const fresh = await contracts.readComposedWorkflowHistory(
    histories.map((item) => item.source.scope),
    { cwd, gh },
  )
  if (!fresh.ok) return { ok: false, reason: fresh.reason }
  const authorized = authorizeExpandedStart(record.payload, fresh.histories)
  if (!authorized.ok) return authorized
  return validateExpandedStartLive(record.payload, fresh.histories, { cwd, gh })
}

export async function recheckStartPublication(
  record: CanonicalRecord,
  contracts: Contracts,
  histories: readonly History[],
  cwd: string,
  gh: Gh,
): Promise<Checked> {
  if (record.kind !== 'action-receipt' || record.payload.phase !== 'start' || !hasExpandedStart(record.payload))
    return { ok: true }
  const scopes = histories.map((item) => item.source.scope)
  const fresh = await contracts.readComposedWorkflowHistory(scopes, { cwd, gh })
  if (!fresh.ok) return { ok: false, reason: fresh.reason }
  const authorized = recheckExpandedStart(record as StartRecord, fresh.histories)
  if (!authorized.ok) return authorized
  const beforeStart = fresh.histories.map((item) => ({
    ...item,
    operations: item.operations.filter(
      (operation) =>
        operation.record?.recordId !== record.recordId ||
        operation.record?.repository !== record.repository ||
        operation.record?.target !== record.target,
    ),
  }))
  return validateExpandedStartLive(record.payload, beforeStart, { cwd, gh })
}
