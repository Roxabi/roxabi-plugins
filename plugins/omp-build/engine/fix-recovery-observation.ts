import { createHash } from 'node:crypto'
import { canonicalValueDigest } from './action-input.ts'
import { type FixRecoveryObservation, fixRecoveryObservationSchema } from './fix-recovery-control-schema.ts'
import { discoverSelectedRecoveryOwner } from './fix-recovery-discovery.ts'
import { matchesCompletePin } from './fix-recovery-discovery-records.ts'
import { captureCuts } from './fix-recovery-observation-cuts.ts'
import { fixRecoveryGraphFacts } from './fix-recovery-proposal.ts'
import { replayFixRecoveryControl, selectUnclosedRecoveryOwner } from './fix-recovery-replay.ts'
import type { FixOwnerOpenedPayload, FixOwnerSettledPayload, OpenedRef } from './fix-recovery-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { scopeKey, type UwGraphObservation } from './uw-graph.ts'

export type FixRecoveryCurrentFacts = Pick<
  FixRecoveryObservation,
  'authority' | 'pullRequest' | 'local' | 'host' | 'catalogues'
>
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const failure = (message: string): Result<never> => ({ ok: false, diagnostics: [diagnostic('unconfirmed', message)] })

/** Captures source-backed facts only; eligibility and native authority are separate. */
export function makeFixRecoveryObservation(input: {
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
  current: FixRecoveryCurrentFacts
}): Result<FixRecoveryObservation> {
  return captureFixRecoveryObservation(input)
}

/** Fresh facts for the exact owner named by an already replayed adoption control. */
export function makeFixRecoveryClaimObservation(input: {
  control: Extract<CanonicalRecord, { kind: 'fix-recovery' }>
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
  current: FixRecoveryCurrentFacts
}): Result<FixRecoveryObservation> {
  const replayed = replayFixRecoveryControl({ control: input.control, histories: input.histories })
  if (!replayed.ok) return replayed
  if (replayed.value.proposal.phase !== 'adopt-decision') return failure('Control does not reserve an adoption claim')
  return captureFixRecoveryObservation(input, replayed.value.proposal.opened)
}

type CaptureInput = {
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
  current: FixRecoveryCurrentFacts
}

function uniqueHistories(source: readonly DecodedHistory[]): Result<DecodedHistory[]> {
  const byScope = new Map<string, DecodedHistory>()
  for (const history of source) {
    const key = scopeKey(history.source.scope)
    const previous = byScope.get(key)
    if (previous !== undefined && canonicalValueDigest(previous) !== canonicalValueDigest(history))
      return failure('Recovery history scope has conflicting observations')
    byScope.set(key, history)
  }
  return { ok: true, value: [...byScope.values()] }
}

function ownerPayloads(
  histories: readonly DecodedHistory[],
  owner: OpenedRef,
  settled: OpenedRef,
): Result<{ opening: FixOwnerOpenedPayload; settlement: FixOwnerSettledPayload }> {
  const operations = histories.flatMap((history) => history.operations)
  const owners = operations.filter(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'fix-owner' &&
      operation.record.recordId === owner.recordId &&
      equalScope(operation.record, owner.scope),
  )
  const settlements = operations.filter(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'fix-owner' &&
      operation.record.recordId === settled.recordId &&
      equalScope(operation.record, settled.scope),
  )
  const opening = owners[0]?.record
  const settlement = settlements[0]?.record
  if (
    owners.length !== 1 ||
    opening?.kind !== 'fix-owner' ||
    opening.payload.phase !== 'opened' ||
    settlements.length !== 1 ||
    settlement?.kind !== 'fix-owner' ||
    settlement.payload.phase !== 'settled'
  )
    return failure('Recovery owner lifecycle changed during observation')
  return { ok: true, value: { opening: opening.payload, settlement: settlement.payload } }
}

function validateCurrent(
  input: CaptureInput,
  histories: readonly DecodedHistory[],
  common: FixOwnerOpenedPayload['common'],
): Result<FixRecoveryCurrentFacts['authority']['plugin']['files']> {
  const { authority, pullRequest, local } = input.current
  const binding = histories
    .flatMap((history) => history.operations)
    .find(
      (operation) =>
        operation.record?.kind === 'workflow-binding' &&
        operation.record.recordId === authority.binding.identity.recordId &&
        equalScope(operation.record, authority.binding.identity.scope),
    )?.record
  if (
    !matchesCompletePin(histories, authority.binding) ||
    !matchesCompletePin(histories, authority.mandate) ||
    !sameRef(authority.binding.identity, common.binding) ||
    !sameRef(authority.mandate.identity, common.mandate) ||
    canonicalValueDigest(authority.accepted) !== common.acceptedDigest ||
    canonicalValueDigest(authority.plugin) !== canonicalValueDigest(common.plugin) ||
    canonicalValueDigest(authority.configuration) !== canonicalValueDigest(common.configuration) ||
    !equalScope(pullRequest.scope, common.pullRequest) ||
    binding?.kind !== 'workflow-binding' ||
    binding.payload.branch !== pullRequest.branch ||
    binding.payload.base !== pullRequest.base ||
    canonicalValueDigest(pullRequest.destination) !== canonicalValueDigest(common.destination) ||
    createHash('sha256').update(local.status.stdout, 'utf8').digest('hex') !== local.statusDigest ||
    local.clean !== (local.status.stdout.trim() === '')
  )
    return failure('Recovery current authority, pull request, or local status differs from observed facts')
  const fileKey = (file: { repository: string; commit: string; path: string }) =>
    [file.repository, file.commit, file.path].join('\0')
  const files = [...authority.plugin.files].sort((a, b) => compare(fileKey(a), fileKey(b)))
  if (new Set(files.map(fileKey)).size !== files.length) return failure('Recovery plugin pin repeats a file identity')
  return { ok: true, value: files }
}

function captureFixRecoveryObservation(
  input: CaptureInput,
  selectedOpened?: OpenedRef,
): Result<FixRecoveryObservation> {
  const unique = uniqueHistories(input.histories)
  if (!unique.ok) return unique
  const histories = unique.value
  const uw = input.current.authority.accepted.own.uw
  const lineage = selectedOpened === undefined ? selectUnclosedRecoveryOwner(histories, uw) : null
  if (lineage !== null && !lineage.ok) return lineage
  const opened = selectedOpened ?? lineage?.value.opened ?? null
  if (opened === null) return failure('Recovery opening is unavailable')
  const discovery = discoverSelectedRecoveryOwner({ uw, histories, graph: input.graph, opened })
  if (discovery.status !== 'interrupted')
    return failure('Recovery anchor and current authority are not uniquely authenticated')
  const graph = fixRecoveryGraphFacts(input.graph)
  if (!graph.ok) return graph
  const owner = ownerPayloads(histories, discovery.owner, discovery.settled)
  if (!owner.ok) return owner
  const files = validateCurrent(input, histories, owner.value.opening.common)
  if (!files.ok) return files
  const cuts = captureCuts(histories, owner.value.settlement)
  if (!cuts.ok) return cuts
  const { authority } = input.current
  const parsed = fixRecoveryObservationSchema.safeParse({
    format: 'omp-build-fix-recovery-observation/1',
    histories: cuts.value,
    graph: graph.value,
    ...input.current,
    authority: { ...authority, plugin: { ...authority.plugin, files: files.value } },
  })
  return parsed.success
    ? { ok: true, value: parsed.data }
    : failure('Recovery observation facts do not satisfy the strict wire contract')
}
