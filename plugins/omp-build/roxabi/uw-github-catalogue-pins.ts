import type { Result } from '../engine/result.ts'
import { pinVectorQuery } from '../host/preparation-graphql.cjs'
import { actionFailure } from './uw-action-result.ts'
import type { GitByteRequest } from './uw-git-bytes.ts'
import { blobOid, fetchGitHubBlob, ghFailure, jsonBody, record } from './uw-github-blobs.ts'

function errorAlias(error: unknown): number {
  const path = record(error) ? error.path : undefined
  if (!Array.isArray(path) || path.length !== 2 || path[0] !== 'repository' || typeof path[1] !== 'string') return -1
  const match = /^f(0|[1-9][0-9]*)$/.exec(path[1])
  return match ? Number(match[1]) : -1
}

function failedAliases(value: Record<string, unknown>, count: number, exitedNonzero: boolean): Set<number> | null {
  if ('errors' in value && !Array.isArray(value.errors)) return null
  if (exitedNonzero && (!Array.isArray(value.errors) || value.errors.length === 0)) return null
  const failed = new Set<number>()
  if (!Array.isArray(value.errors)) return failed
  for (const error of value.errors) {
    const index = errorAlias(error)
    if (index < 0 || index >= count || failed.has(index)) return null
    failed.add(index)
  }
  return failed
}

/** Each alias is independently observed; partial errors must be uniquely attributed. */
export async function readGitHubCataloguePins(
  requests: readonly GitByteRequest[],
): Promise<readonly Result<Uint8Array>[]> {
  const first = requests[0]
  if (first === undefined) return []
  if (requests.some((pin) => pin.repository !== first.repository || pin.gh !== first.gh || pin.cwd !== first.cwd))
    return requests.map(() => actionFailure('pinned-file-unreadable', 'Catalogue pins require one GitHub read context'))
  const slash = first.repository.indexOf('/')
  const missing = first.repository
  let raw: string
  let exitedNonzero = false
  try {
    raw = await first.gh(first.cwd ?? '', [
      'api',
      'graphql',
      '-f',
      `query=${pinVectorQuery(requests.length)}`,
      '-f',
      `owner=${first.repository.slice(0, slash)}`,
      '-f',
      `name=${first.repository.slice(slash + 1)}`,
      ...requests.flatMap((request, index) => ['-f', `e${index}=${request.commit}:${request.path}`]),
    ])
  } catch (error) {
    exitedNonzero = true
    // execFile exposes stdout even when gh exits nonzero on GraphQL errors.
    if (!record(error) || typeof error.stdout !== 'string' || error.stdout.length === 0)
      return requests.map(() => ghFailure(error, missing))
    raw = error.stdout
  }
  const parsed = jsonBody(raw, missing, 'blob lookup')
  if (!parsed.ok) return requests.map(() => parsed)
  const value = parsed.value
  const failed = record(value) ? failedAliases(value, requests.length, exitedNonzero) : null
  const data = record(value) ? value.data : null
  const repository = record(data) ? data.repository : null
  if (failed === null || !record(repository))
    return requests.map(() => actionFailure('pinned-file-unreadable', `Invalid GitHub blob lookup: ${missing}`))
  const fetched = new Map<string, Promise<Result<Uint8Array>>>()
  return Promise.all(
    requests.map(async (request, index) => {
      const path = `${request.repository}@${request.commit}:${request.path}`
      if (failed.has(index))
        return actionFailure('pinned-file-unreadable', `Cross-repository Git object is unreadable: ${path}`)
      const oid = blobOid({ data: { repository } }, `f${index}`)
      if (oid === 'unreadable')
        return actionFailure('pinned-file-unreadable', `Cross-repository Git object is unreadable: ${path}`)
      if (oid === 'absent') return actionFailure('pinned-file-incomplete', `Pinned path is not a Git blob: ${path}`)
      let result = fetched.get(oid)
      if (result === undefined) {
        result = fetchGitHubBlob(request, oid, `${request.repository}/git/blobs/${oid}`)
        fetched.set(oid, result)
      }
      const observed = await result
      return observed.ok
        ? observed
        : {
            ...observed,
            diagnostics: observed.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              message: `${path}: ${diagnostic.message}`,
            })),
          }
    }),
  )
}
