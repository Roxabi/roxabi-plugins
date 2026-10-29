import { canonicalValueDigest, citesCurrentRootOutput } from '../dist/contracts.js'
import type { ActionInputManifest } from '../engine/action-input-schema.ts'
import type { Result } from '../engine/result.ts'
import type { RecordInputRef, UwActionPorts, UwActionRequest } from './uw-action-contract.ts'
import { readPinnedPluginFiles } from './uw-action-plugin-files.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'

async function verifyExpandedFile(
  ref: Extract<ActionInputManifest['expandedContext'][number], { source: 'git-file' }>,
  ports: UwActionPorts,
): Promise<Result<true>> {
  const read = await ports.readPinnedFile(ref)
  if (!read.ok) return read
  if (sha256Bytes(read.value) !== ref.digest)
    return actionFailure('review-input-changed', `Expanded context ${ref.path} no longer matches its digest`)
  return { ok: true, value: true }
}

async function verifyExpandedRecord(ref: RecordInputRef, ports: UwActionPorts): Promise<Result<true>> {
  if (ports.readAccountedRecord === undefined)
    return actionFailure('record-unreadable', 'Expanded record accounting is unavailable')
  const read = await ports.readAccountedRecord(ref)
  if (!read.ok) return read
  if (canonicalValueDigest(read.value) !== ref.digest)
    return actionFailure('review-input-changed', `Expanded context ${ref.record.recordId} no longer matches its digest`)
  return { ok: true, value: true }
}

export async function verifyExpandedContext(
  refs: readonly ActionInputManifest['expandedContext'][number][],
  ports: UwActionPorts,
): Promise<Result<true>> {
  for (const ref of refs) {
    const result =
      ref.source === 'git-file' ? await verifyExpandedFile(ref, ports) : await verifyExpandedRecord(ref, ports)
    if (!result.ok) return result
  }
  return { ok: true, value: true }
}

export async function verifyReviewedPlugin(manifest: ActionInputManifest, ports: UwActionPorts): Promise<Result<true>> {
  const remote = await readPinnedPluginFiles(manifest.plugin.files, ports)
  if (!remote.ok) return remote
  return { ok: true, value: true }
}

export async function acceptCurrentManifest(
  request: UwActionRequest,
  ports: UwActionPorts,
  manifest: ActionInputManifest,
  currentOutputs: readonly RecordInputRef[],
): Promise<Result<ActionInputManifest>> {
  const cited = citesCurrentRootOutput(
    { format: 'omp-build-action-input-binding/1', manifest, fingerprint: '0'.repeat(64), stageSources: [] },
    currentOutputs,
  )
  if (cited.length > 0) return { ok: false, diagnostics: cited }
  const expanded = await verifyExpandedContext(request.expandedContext, ports)
  if (!expanded.ok) return expanded
  return { ok: true, value: manifest }
}
