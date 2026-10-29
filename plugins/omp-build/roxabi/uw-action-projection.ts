import type { ActionInputManifest, PinnedFileRef } from '../engine/action-input-schema.ts'
import type { Result } from '../engine/result.ts'
import type { PreparedReviewChunk, ReviewFile } from './review-input-contract.ts'
import type { ReviewActionProjection, UwActionPorts } from './uw-action-contract.ts'
import { dossierIndex } from './uw-action-dossier.ts'
import { actionFailure } from './uw-action-result.ts'

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

function headPin(refs: readonly PinnedFileRef[], head: string, path: string): PinnedFileRef | undefined {
  return refs.find((ref) => ref.commit === head && ref.path === path)
}

async function confirmFile(
  ports: UwActionPorts,
  refs: readonly PinnedFileRef[],
  head: string,
  file: ReviewFile,
): Promise<Result<true>> {
  const pinned = headPin(refs, head, file.path)
  if (file.deleted) {
    if (pinned !== undefined)
      return actionFailure('action-input-stale', 'Deleted review file is still at HEAD: ' + file.path)
    return { ok: true, value: true }
  }
  if (pinned === undefined)
    return actionFailure('action-input-missing', 'Review file has no pinned HEAD blob: ' + file.path)
  const bytes = await ports.readPinnedFile(pinned)
  if (!bytes.ok) return bytes
  if (file.binary) return { ok: true, value: true }
  if (file.text === null || file.text !== utf8(bytes.value))
    return actionFailure('action-input-stale', 'Review file text does not match pinned HEAD bytes: ' + file.path)
  return { ok: true, value: true }
}

function selected(projection: ReviewActionProjection): Result<readonly PreparedReviewChunk[]> {
  if (projection.assignedChunk === null) return { ok: true, value: projection.chunks }
  const chunk = projection.chunks.find((item) => item.index === projection.assignedChunk)
  if (chunk === undefined)
    return actionFailure(
      'action-input-missing',
      'Assigned chunk ' + String(projection.assignedChunk) + ' is not in the captured list',
    )
  return { ok: true, value: [chunk] }
}

function meta(chunk: PreparedReviewChunk): {
  index: number
  paths: string[]
  files: { path: string; oldPath: string | null; hunk: string | null; deleted: boolean; binary: boolean }[]
} {
  return {
    index: chunk.index,
    paths: chunk.files.map((file) => file.path),
    files: chunk.files.map((file) => ({
      path: file.path,
      oldPath: file.oldPath ?? null,
      hunk: file.hunk ?? null,
      deleted: file.deleted,
      binary: file.binary,
    })),
  }
}

export function assignedIndexLine(projection: ReviewActionProjection): string {
  const label = projection.assignedChunk === null ? 'all/spec' : String(projection.assignedChunk)
  return 'Assigned chunk ' + label
}

export function sealedIndex(
  manifest: ActionInputManifest,
  files: readonly { path: string }[],
  projection?: ReviewActionProjection,
): Uint8Array {
  const body = Buffer.from(dossierIndex(manifest, files)).toString('utf8')
  if (projection === undefined) return Buffer.from(body, 'utf8')
  return Buffer.from(body + assignedIndexLine(projection) + '\n', 'utf8')
}

export async function projectionFiles(
  ports: UwActionPorts,
  manifest: ActionInputManifest,
  projection: ReviewActionProjection,
): Promise<Result<readonly { path: string; bytes: Uint8Array }[]>> {
  const seen = new Set<number>()
  for (const chunk of projection.chunks) {
    if (seen.has(chunk.index))
      return actionFailure('action-input-missing', 'Captured chunk index is not unique: ' + String(chunk.index))
    seen.add(chunk.index)
    for (const file of chunk.files) {
      const confirmed = await confirmFile(ports, manifest.repositoryReferences, manifest.code.head, file)
      if (!confirmed.ok) return confirmed
    }
  }
  const slices = selected(projection)
  if (!slices.ok) return slices
  const assignment = JSON.stringify({
    taskName: projection.taskName,
    assignedChunk: projection.assignedChunk,
    contextWindow: projection.contextWindow,
    chunks: slices.value.map(meta),
  })
  const files: { path: string; bytes: Uint8Array }[] = [
    { path: 'review/assignment.json', bytes: Buffer.from(assignment, 'utf8') },
  ]
  for (const chunk of slices.value) {
    files.push({ path: 'review/chunks/' + String(chunk.index) + '.patch', bytes: Buffer.from(chunk.diff, 'utf8') })
  }
  for (const chunk of projection.chunks) {
    files.push({ path: 'review/digests/' + String(chunk.index) + '.md', bytes: Buffer.from(chunk.digest, 'utf8') })
  }
  return { ok: true, value: files }
}

export function repositorySealPath(ref: PinnedFileRef, used: Set<string>): string {
  const plain = 'repo/' + ref.path
  if (!used.has(plain)) {
    used.add(plain)
    return plain
  }
  used.add('repo/' + ref.commit + '/' + ref.path)
  return 'repo/' + ref.commit + '/' + ref.path
}
