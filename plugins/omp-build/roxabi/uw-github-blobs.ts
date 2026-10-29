import { createHash } from 'node:crypto'
import type { Gh } from '../adapters/github/types.ts'
import type { Result } from '../engine/result.ts'
import { actionFailure, isGitSha } from './uw-action-result.ts'
import type { GitByteRequest } from './uw-git-bytes.ts'

const BLOB_QUERY =
  'query($owner:String!,$name:String!,$expression:String!){repository(owner:$owner,name:$name){object(expression:$expression){... on Blob{oid}}}}'

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

function decodeBase64(value: string, size: number): Uint8Array | null {
  const compact = value.replace(/[ \t\r\n]/g, '')
  if (compact.length === 0) return size === 0 ? new Uint8Array() : null
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) return null
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.toString('base64') !== compact || bytes.byteLength !== size) return null
  return bytes
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function blobOid(parsed: unknown, alias = 'object'): string | 'absent' | 'unreadable' {
  if (
    !record(parsed) ||
    !('data' in parsed) ||
    ('errors' in parsed && (!Array.isArray(parsed.errors) || parsed.errors.length > 0))
  )
    return 'unreadable'
  const data = parsed.data
  if (!record(data) || !('repository' in data)) return 'unreadable'
  const repository = data.repository
  if (!record(repository) || !(alias in repository)) return 'unreadable'
  if (repository[alias] === null) return 'absent'
  const object = repository[alias]
  if (!record(object) || !('oid' in object) || typeof object.oid !== 'string' || !isGitSha(object.oid)) return 'absent'
  return object.oid
}

function blobBody(parsed: unknown): { content: string; size: number; sha: string } | null {
  if (
    !record(parsed) ||
    parsed.encoding !== 'base64' ||
    typeof parsed.content !== 'string' ||
    typeof parsed.sha !== 'string'
  )
    return null
  if (typeof parsed.size !== 'number' || !Number.isSafeInteger(parsed.size) || parsed.size < 0) return null
  return { content: parsed.content, size: parsed.size, sha: parsed.sha }
}

function ghFailure(error: unknown, missing: string): Result<never> {
  const detail = error instanceof Error ? error.message : 'no local fallback'
  return actionFailure('pinned-file-unreadable', `Cross-repository Git object is unreadable: ${missing}. ${detail}`)
}

async function ghText(gh: Gh, cwd: string | undefined, args: string[], missing: string): Promise<Result<string>> {
  try {
    return { ok: true, value: await gh(cwd ?? '', args) }
  } catch (error) {
    return ghFailure(error, missing)
  }
}

function jsonBody(raw: string, missing: string, label: string): Result<unknown> {
  try {
    return { ok: true, value: JSON.parse(raw) }
  } catch {
    return actionFailure('pinned-file-unreadable', `GitHub ${label} is not JSON for ${missing}`)
  }
}

/** Commit:path blob oid, then that Git blob. Not the Contents API: it follows symlinks. */
export async function readGitHubBlob(request: GitByteRequest): Promise<Result<Uint8Array>> {
  const missing = `${request.repository}@${request.commit}:${request.path}`
  const slash = request.repository.indexOf('/')
  const located = await ghText(
    request.gh,
    request.cwd,
    [
      'api',
      'graphql',
      '-f',
      `query=${BLOB_QUERY}`,
      '-f',
      `owner=${request.repository.slice(0, slash)}`,
      '-f',
      `name=${request.repository.slice(slash + 1)}`,
      '-f',
      `expression=${request.commit}:${request.path}`,
    ],
    missing,
  )
  if (!located.ok) return located
  const lookup = jsonBody(located.value, missing, 'blob lookup')
  if (!lookup.ok) return lookup
  const oid = blobOid(lookup.value)
  if (oid === 'unreadable')
    return actionFailure('pinned-file-unreadable', `Cross-repository Git object is unreadable: ${missing}`)
  if (oid === 'absent') return actionFailure('pinned-file-incomplete', `Pinned path is not a Git blob: ${missing}`)
  return fetchGitHubBlob(request, oid)
}

async function fetchGitHubBlob(request: GitByteRequest, oid: string): Promise<Result<Uint8Array>> {
  const missing = `${request.repository}@${request.commit}:${request.path}`
  const raw = await ghText(
    request.gh,
    request.cwd,
    [
      'api',
      '--method',
      'GET',
      `repos/${request.repository}/git/blobs/${oid}`,
      '-H',
      'Accept: application/vnd.github+json',
    ],
    missing,
  )
  if (!raw.ok) return raw
  const parsed = jsonBody(raw.value, missing, 'blob response')
  if (!parsed.ok) return parsed
  const body = blobBody(parsed.value)
  if (body === null || body.sha !== oid)
    return actionFailure('pinned-file-incomplete', `Pinned blob sha does not match decoded bytes: ${missing}`)
  const bytes = decodeBase64(body.content, body.size)
  if (bytes === null || gitBlobSha(bytes) !== oid)
    return actionFailure('pinned-file-incomplete', `Pinned blob sha does not match decoded bytes: ${missing}`)
  return { ok: true, value: bytes }
}

type CatalogueBlob = { oid: string; bytes: Uint8Array | null }
type BlobMetadata = { byteSize: number; isBinary: boolean | null; isTruncated: boolean; text: string | null }

function blobMetadata(value: unknown): value is BlobMetadata {
  return (
    record(value) &&
    typeof value.byteSize === 'number' &&
    Number.isSafeInteger(value.byteSize) &&
    value.byteSize >= 0 &&
    (value.isBinary === null || typeof value.isBinary === 'boolean') &&
    typeof value.isTruncated === 'boolean' &&
    (value.text === null || typeof value.text === 'string')
  )
}

function catalogueBlob(lookup: unknown, alias: string, request: GitByteRequest): Result<CatalogueBlob> {
  const oid = blobOid(lookup, alias)
  const path = `${request.repository}@${request.commit}:${request.path}`
  if (oid === 'unreadable')
    return actionFailure('pinned-file-unreadable', `Cross-repository Git object is unreadable: ${path}`)
  if (oid === 'absent') return actionFailure('pinned-file-incomplete', `Pinned path is not a Git blob: ${path}`)
  const data = record(lookup) ? lookup.data : null
  const repository = record(data) ? data.repository : null
  const object = record(repository) ? repository[alias] : null
  if (!blobMetadata(object))
    return actionFailure('pinned-file-incomplete', `Pinned blob metadata is incomplete: ${path}`)
  if (object.isBinary !== false || object.isTruncated) return { ok: true, value: { oid, bytes: null } }
  if (typeof object.text !== 'string')
    return actionFailure('pinned-file-incomplete', `Pinned blob text is incomplete: ${path}`)
  const bytes = Buffer.from(object.text, 'utf8')
  if (bytes.toString('utf8') !== object.text || bytes.byteLength !== object.byteSize || gitBlobSha(bytes) !== oid)
    return actionFailure('pinned-file-incomplete', `Pinned blob sha does not match decoded bytes: ${path}`)
  return { ok: true, value: { oid, bytes } }
}

async function lookupCatalogue(requests: readonly GitByteRequest[]): Promise<Result<readonly CatalogueBlob[]>> {
  const first = requests[0]
  const variables = requests.map((_, index) => `$e${index}:String!`).join(',')
  const fields = requests
    .map((_, index) => `f${index}:object(expression:$e${index}){... on Blob{oid byteSize isBinary isTruncated text}}`)
    .join(' ')
  const query = `query($owner:String!,$name:String!,${variables}){repository(owner:$owner,name:$name){${fields}}}`
  const slash = first.repository.indexOf('/')
  const missing = `${first.repository}@${first.commit}`
  const located = await ghText(
    first.gh,
    first.cwd,
    [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `owner=${first.repository.slice(0, slash)}`,
      '-f',
      `name=${first.repository.slice(slash + 1)}`,
      ...requests.flatMap((request, index) => ['-f', `e${index}=${request.commit}:${request.path}`]),
    ],
    missing,
  )
  if (!located.ok) return located
  const lookup = jsonBody(located.value, missing, 'blob lookup')
  if (!lookup.ok) return lookup
  if (record(lookup.value) && Array.isArray(lookup.value.errors) && lookup.value.errors.length > 0)
    return actionFailure(
      'pinned-file-unreadable',
      `GitHub blob lookup failed for ${missing}: ${JSON.stringify(lookup.value.errors)}`,
    )
  const blobs: CatalogueBlob[] = []
  for (const [index, request] of requests.entries()) {
    const blob = catalogueBlob(lookup.value, `f${index}`, request)
    if (!blob.ok) return blob
    blobs.push(blob.value)
  }
  return { ok: true, value: blobs }
}

async function materializeCatalogue(
  requests: readonly GitByteRequest[],
  blobs: readonly CatalogueBlob[],
): Promise<Result<readonly Uint8Array[]>> {
  const bytes: Uint8Array[] = []
  for (const [index, request] of requests.entries()) {
    const blob = blobs[index]
    if (blob.bytes !== null) {
      bytes.push(blob.bytes)
      continue
    }
    const raw = await fetchGitHubBlob(request, blob.oid)
    if (!raw.ok) return raw
    bytes.push(raw.value)
  }
  return { ok: true, value: bytes }
}

async function commitBarrier(first: GitByteRequest): Promise<Result<true>> {
  const missing = `${first.repository}@${first.commit}`
  const barrier = await ghText(
    first.gh,
    first.cwd,
    [
      'api',
      '--method',
      'GET',
      `repos/${first.repository}/git/commits/${first.commit}`,
      '-H',
      'Accept: application/vnd.github+json',
    ],
    missing,
  )
  if (!barrier.ok) return barrier
  const commit = jsonBody(barrier.value, missing, 'commit response')
  if (!commit.ok) return commit
  if (!record(commit.value) || commit.value.sha !== first.commit)
    return actionFailure('pinned-file-incomplete', `Pinned commit sha does not match: ${missing}`)
  return { ok: true, value: true }
}

export async function readGitHubBlobs(requests: readonly GitByteRequest[]): Promise<Result<readonly Uint8Array[]>> {
  const lookup = await lookupCatalogue(requests)
  if (!lookup.ok) return lookup
  const bytes = await materializeCatalogue(requests, lookup.value)
  if (!bytes.ok) return bytes
  const barrier = await commitBarrier(requests[0])
  if (!barrier.ok) return barrier
  return bytes
}
