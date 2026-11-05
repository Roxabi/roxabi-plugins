import type { Gh } from '../adapters/github/types.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Contracts, History } from './feature-engine.ts'
import {
  authorizeExpandedStart,
  hasExpandedStart,
  recheckExpandedStart,
  validateExpandedStartLive,
} from './feature-start-expansion.ts'
import { readFixUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'

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
  const options = withRoxabiGitHubPolicy({ cwd, gh })
  const fresh = await contracts.readComposedWorkflowHistory(
    histories.map((item) => item.source.scope),
    options,
  )
  if (!fresh.ok) return { ok: false, reason: fresh.reason }
  const causal = await readFixUwCausalContext(fresh.histories, [], options)
  if (!causal.ok) return { ok: false, reason: causal.diagnostics[0] ?? 'causal-history-unavailable' }
  const authorized = authorizeExpandedStart(record.payload, fresh.histories, causal.value)
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
  const options = withRoxabiGitHubPolicy({ cwd, gh })
  const fresh = await contracts.readComposedWorkflowHistory(scopes, options)
  if (!fresh.ok) return { ok: false, reason: fresh.reason }
  const causal = await readFixUwCausalContext(fresh.histories, [], options)
  if (!causal.ok) return { ok: false, reason: causal.diagnostics[0] ?? 'causal-history-unavailable' }
  const authorized = recheckExpandedStart(record, fresh.histories, causal.value)
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
