import { type PinnedFileRef, pinnedFileRefSchema, recordInputRefSchema } from '../../engine/action-input-refs.ts'
import type { ObservationRef } from '../../engine/criterion-evidence-schema.ts'
import { recordRefDiagnostics } from '../../engine/historical-action-inputs.ts'
import { gitPinCoordinates, recordGitPinBytes } from '../../engine/historical-git-pins.ts'
import { noteObservedRecordPin } from '../../engine/historical-record-pins.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { equalScope } from '../../engine/record-diagnostics.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { readGitFileBytes } from '../../roxabi/uw-git-bytes.ts'
import { decodeHistory } from './history-codec.ts'
import { readGitHubHistory } from './transport.ts'
import { type GitHubOptions, gh } from './types.ts'

type PinRequest = { candidate?: CanonicalRecord; references?: readonly ObservationRef[]; includeHistory?: boolean }
// Match historical authority manifests and explicit producer citations; raw executor logs are not authority.
function collectPins(value: unknown, add: (pin: ObservationRef) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPins(item, add)
    return
  }
  if (value === null || typeof value !== 'object') return
  const fields = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(fields)) {
    if (key === 'references') collectRefs(entry, add, false)
    else if (key === 'manifest') collectManifestPins(entry, add)
    else if (key !== 'raw' && key !== 'rawAttempts') collectPins(entry, add)
  }
}

function collectManifestPins(value: unknown, add: (pin: ObservationRef) => void) {
  if (value === null || typeof value !== 'object') return
  const manifest = value as Record<string, unknown>
  collectRefs(manifest.expandedContext, add, true)
  collectRefs(manifest.repositoryReferences, add, false)
  if (manifest.plugin !== null && typeof manifest.plugin === 'object' && 'files' in manifest.plugin)
    collectRefs(manifest.plugin.files, add, false)
}

function collectRefs(value: unknown, add: (pin: ObservationRef) => void, records: boolean): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (item === null || typeof item !== 'object' || !('source' in item)) continue
    if (item.source !== 'git-file' && !(records && item.source === 'record')) continue
    const parsed = (item.source === 'git-file' ? pinnedFileRefSchema : recordInputRefSchema).safeParse(item)
    if (parsed.success) add(parsed.data)
  }
}

function historicalPinGroups(history: DecodedHistory, additional: PinRequest | undefined) {
  const recordScopes = new Map<string, { scope: Scope; refs: Extract<ObservationRef, { source: 'record' }>[] }>()
  const groups = new Map<string, Map<string, PinnedFileRef>>()
  const add = (pin: ObservationRef) => {
    if (pin.source === 'record') {
      const scope = pin.record.scope
      if (equalScope(scope, history.source.scope)) return
      const key = JSON.stringify([scope.repository, scope.target])
      const group = recordScopes.get(key)
      if (group === undefined) recordScopes.set(key, { scope, refs: [pin] })
      else group.refs.push(pin)
      return
    }
    const key = gitPinCoordinates(pin)
    let group = groups.get(key)
    if (group === undefined) {
      group = new Map()
      groups.set(key, group)
    }
    group.set(pin.digest, pin)
  }
  if (additional?.includeHistory !== false) {
    for (const operation of history.operations) {
      if (operation.status === 'complete' && operation.authority !== 'foreign' && operation.record !== null)
        collectPins(operation.record.payload, add)
    }
  }
  if (additional?.candidate !== undefined) collectPins(additional.candidate.payload, add)
  for (const ref of additional?.references ?? []) if (ref.source === 'git-file') add(ref)
  return { groups, recordScopes }
}

export async function observeHistoricalPins(
  history: DecodedHistory,
  options: GitHubOptions,
  additional?: PinRequest,
): Promise<DecodedHistory> {
  const { groups, recordScopes } = historicalPinGroups(history, additional)
  await observeGitPinGroups(history, options, groups)
  for (const { scope, refs } of recordScopes.values()) {
    // Related evidence is not an additional authority root; unavailability affects only the citing manifest.
    const source = await readGitHubHistory(scope, options).catch(() => null)
    if (source === null || !source.complete) continue
    const cited = decodeHistory(source)
    for (const ref of refs) {
      if (recordRefDiagnostics('Historical action manifest', ref, [cited]).length === 0)
        noteObservedRecordPin(history.source, ref, cited)
    }
  }
  return history
}

async function observeGitPinGroups(
  history: DecodedHistory,
  options: GitHubOptions,
  groups: ReadonlyMap<string, ReadonlyMap<string, PinnedFileRef>>,
) {
  if (groups.size === 0) return
  const batch: Promise<void>[] = []
  const transport = gh(options)
  for (const group of groups.values()) {
    const pin = group.values().next().value
    if (pin === undefined) continue
    const { repository, commit, path } = pin
    batch.push(
      readGitFileBytes({ repository, commit, path, cwd: options.cwd, gh: transport }).then((bytes) => {
        if (bytes.ok) recordGitPinBytes(history, group.values(), bytes.value)
      }),
    )
    if (batch.length < 4) continue
    await Promise.all(batch)
    batch.length = 0
  }
  if (batch.length > 0) await Promise.all(batch)
}

export async function readDecodedGitHubHistory(scope: Scope, options: GitHubOptions): Promise<DecodedHistory> {
  return observeHistoricalPins(decodeHistory(await readGitHubHistory(scope, options)), options)
}
