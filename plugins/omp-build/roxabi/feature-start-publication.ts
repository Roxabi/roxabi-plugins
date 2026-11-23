import type { Gh } from '../adapters/github/types.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Contracts, History } from './feature-engine.ts'
import { authorizeExpandedStart, recheckExpandedStart } from './feature-start-expansion.ts'
import { readFreshUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'

type Checked = { ok: true } | { ok: false; reason: string }

export async function authorizeStartPublication(
  record: CanonicalRecord,
  contracts: Contracts,
  histories: readonly History[],
  cwd: string,
  gh: Gh,
): Promise<Checked> {
  if (
    record.kind !== 'action-receipt' ||
    record.payload.phase !== 'start' ||
    record.payload.action !== 'assess-spec' ||
    record.payload.inputs.manifest.expandedContext.length === 0
  )
    return { ok: true }
  const options = withRoxabiGitHubPolicy({ cwd, gh })
  const fresh = await contracts.readComposedWorkflowHistory(
    histories.map((item) => item.source.scope),
    options,
  )
  if (!fresh.ok) return { ok: false, reason: fresh.reason }
  const subject = record.payload.inputs.manifest.subject
  if (subject.kind !== 'uw') return { ok: false, reason: 'causal-uw-unavailable' }
  const causal = await readFreshUwCausalContext(subject.uw, fresh.histories, options)
  if (!causal.ok) return { ok: false, reason: causal.diagnostics[0] ?? 'causal-history-unavailable' }
  return authorizeExpandedStart(record.payload, causal.value.histories)
}

export async function recheckStartPublication(
  record: CanonicalRecord,
  contracts: Contracts,
  histories: readonly History[],
  cwd: string,
  gh: Gh,
): Promise<Checked> {
  if (
    record.kind !== 'action-receipt' ||
    record.payload.phase !== 'start' ||
    record.payload.action !== 'assess-spec' ||
    record.payload.inputs.manifest.expandedContext.length === 0
  )
    return { ok: true }
  const scopes = histories.map((item) => item.source.scope)
  const options = withRoxabiGitHubPolicy({ cwd, gh })
  const fresh = await contracts.readComposedWorkflowHistory(scopes, options)
  if (!fresh.ok) return { ok: false, reason: fresh.reason }
  const subject = record.payload.inputs.manifest.subject
  if (subject.kind !== 'uw') return { ok: false, reason: 'causal-uw-unavailable' }
  const causal = await readFreshUwCausalContext(subject.uw, fresh.histories, options)
  if (!causal.ok) return { ok: false, reason: causal.diagnostics[0] ?? 'causal-history-unavailable' }
  return recheckExpandedStart(record, causal.value.histories)
}
