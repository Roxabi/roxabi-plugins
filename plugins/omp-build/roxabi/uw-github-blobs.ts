import { createHash } from 'node:crypto'
import type { Gh } from '../adapters/github/types.ts'
import type { Result } from '../engine/result.ts'
import { BLOB_QUERY } from '../host/preparation-graphql.cjs'
import { actionFailure, isGitSha } from './uw-action-result.ts'
import type { GitByteRequest } from './uw-git-bytes.ts'

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

function blobOid(parsed: unknown, expectedCommit: string): string | 'absent' | 'invalid-commit' | 'unreadable' {
  if (
    !record(parsed) ||
    !('data' in parsed) ||
    ('errors' in parsed && (!Array.isArray(parsed.errors) || parsed.errors.length > 0))
  )
    return 'unreadable'
  const data = parsed.data
  if (!record(data) || !('repository' in data)) return 'unreadable'
  const repository = data.repository
  if (!record(repository) || !('commit' in repository) || !('object' in repository)) return 'unreadable'
  const commit = repository.commit
  if (!record(commit) || commit.__typename !== 'Commit' || commit.oid !== expectedCommit) return 'invalid-commit'
  if (repository.object === null) return 'absent'
  const object = repository.object
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

/** Authenticate the commit and its path's blob OID together, then verify the raw Git blob. */
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
      `commit=${request.commit}`,
      '-f',
      `expression=${request.commit}:${request.path}`,
    ],
    missing,
  )
  if (!located.ok) return located
  const lookup = jsonBody(located.value, missing, 'blob lookup')
  if (!lookup.ok) return lookup
  const oid = blobOid(lookup.value, request.commit)
  if (oid === 'unreadable')
    return actionFailure('pinned-file-unreadable', `Cross-repository Git object is unreadable: ${missing}`)
  if (oid === 'invalid-commit')
    return actionFailure('pinned-file-incomplete', `Pinned object is not the requested Git commit: ${missing}`)
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
