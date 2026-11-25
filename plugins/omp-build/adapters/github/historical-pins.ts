import { type PinnedFileRef, pinnedFileRefSchema } from '../../engine/action-input-refs.ts'
import type { ObservationRef } from '../../engine/criterion-evidence-schema.ts'
import { gitPinCoordinates, recordGitPinBytes } from '../../engine/historical-git-pins.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { readGitFileBytes } from '../../roxabi/uw-git-bytes.ts'
import { decodeHistory } from './history-codec.ts'
import { readGitHubHistory } from './transport.ts'
import { type GitHubOptions, gh } from './types.ts'

// Current positive evidence consumes explicit references and expanded context, not the entire old dossier.
function collectPins(value: unknown, add: (pin: PinnedFileRef) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPins(item, add)
    return
  }
  if (value === null || typeof value !== 'object') return
  const fields = value as Record<string, unknown>
  for (const [key, entry] of Object.entries(fields)) {
    if (key === 'references') collectRefs(entry, add)
    else if (key === 'manifest') collectExpandedContext(entry, add)
    else if (key !== 'raw') collectPins(entry, add)
  }
}

function collectExpandedContext(value: unknown, add: (pin: PinnedFileRef) => void) {
  if (value !== null && typeof value === 'object' && 'expandedContext' in value) collectRefs(value.expandedContext, add)
}

function collectRefs(value: unknown, add: (pin: PinnedFileRef) => void): void {
  if (!Array.isArray(value)) return
  for (const item of value) {
    if (item === null || typeof item !== 'object' || !('source' in item) || item.source !== 'git-file') continue
    const parsed = pinnedFileRefSchema.safeParse(item)
    if (parsed.success) add(parsed.data)
  }
}

function historicalPinGroups(
  history: DecodedHistory,
  additional: { candidate?: CanonicalRecord; references?: readonly ObservationRef[] } | undefined,
) {
  const groups = new Map<string, Map<string, PinnedFileRef>>()
  const add = (pin: PinnedFileRef) => {
    const key = gitPinCoordinates(pin)
    let group = groups.get(key)
    if (group === undefined) {
      group = new Map()
      groups.set(key, group)
    }
    group.set(pin.digest, pin)
  }
  for (const operation of history.operations) {
    if (operation.status === 'complete' && operation.authority !== 'foreign' && operation.record !== null)
      collectPins(operation.record.payload, add)
  }
  if (additional?.candidate !== undefined) collectPins(additional.candidate.payload, add)
  for (const ref of additional?.references ?? []) if (ref.source === 'git-file') add(ref)
  return groups
}

export async function observeHistoricalPins(
  history: DecodedHistory,
  options: GitHubOptions,
  additional?: { candidate?: CanonicalRecord; references?: readonly ObservationRef[] },
): Promise<DecodedHistory> {
  const groups = historicalPinGroups(history, additional)
  if (groups.size === 0) return history
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
  return history
}

export async function readDecodedGitHubHistory(scope: Scope, options: GitHubOptions): Promise<DecodedHistory> {
  return observeHistoricalPins(decodeHistory(await readGitHubHistory(scope, options)), options)
}
