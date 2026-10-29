import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Gh } from '../adapters/github/types.ts'
import type { Result } from '../engine/result.ts'
import { repoRelativePathSchema } from '../engine/schema-primitives.ts'
import { actionFailure, isGitSha } from './uw-action-result.ts'
import { readGitHubBlob, readGitHubBlobs } from './uw-github-blobs.ts'

const execFileAsync = promisify(execFile)
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type GitByteRequest = {
  repository: string
  commit: string
  path: string
  cwd?: string
  gh: Gh
}

function githubRepository(url: string): string | null {
  const match = url
    .trim()
    .match(
      /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/,
    )
  return match?.[1] ?? null
}

async function git(cwd: string, args: string[]): Promise<{ ok: true; stdout: Buffer } | { ok: false }> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'buffer',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    })
    return { ok: true, stdout }
  } catch {
    return { ok: false }
  }
}

/** Declared GitHub origin identity, independent of Git transport URL rewrites. */
export async function checkoutRepository(cwd: string): Promise<string | null> {
  const shown = await git(cwd, ['config', '--get', 'remote.origin.url'])
  if (!shown.ok) return null
  return githubRepository(shown.stdout.toString('utf8'))
}

function gitPaths(stdout: Buffer): readonly string[] {
  return stdout
    .toString('utf8')
    .split('\0')
    .filter((path) => path.length > 0)
}

function pathSegments(path: string): boolean {
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return false
  const segments = path.split('/')
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

/** Exact blob payload. Local objects are used only when that checkout is the named repository. No cache, no HEAD. */
export async function readGitFileBytes(request: GitByteRequest): Promise<Result<Uint8Array>> {
  if (
    !REPOSITORY.test(request.repository) ||
    !isGitSha(request.commit) ||
    !repoRelativePathSchema.safeParse(request.path).success ||
    !pathSegments(request.path)
  ) {
    return actionFailure('pinned-file-unreadable', 'Pinned file coordinates are incomplete')
  }
  if (request.cwd !== undefined && (await checkoutRepository(request.cwd)) === request.repository) {
    const local = await git(request.cwd, ['cat-file', 'blob', `${request.commit}:${request.path}`])
    if (local.ok) return { ok: true, value: local.stdout }
  }
  return readGitHubBlob(request)
}

async function localCatalogue(cwd: string, requests: readonly GitByteRequest[]): Promise<readonly Uint8Array[] | null> {
  const bytes: Uint8Array[] = []
  for (const request of requests) {
    const blob = await git(cwd, ['cat-file', 'blob', `${request.commit}:${request.path}`])
    if (!blob.ok) return null
    bytes.push(blob.stdout)
  }
  return bytes
}

/** Resolve one pinned catalogue in a single observation, then verify every raw blob in order. */
export async function readGitFileBytesBatch(
  requests: readonly GitByteRequest[],
): Promise<Result<readonly Uint8Array[]>> {
  if (requests.length === 0) return { ok: true, value: [] }
  const first = requests[0]
  if (
    !REPOSITORY.test(first.repository) ||
    !isGitSha(first.commit) ||
    requests.some(
      (request) =>
        request.repository !== first.repository ||
        request.commit !== first.commit ||
        request.cwd !== first.cwd ||
        request.gh !== first.gh ||
        !repoRelativePathSchema.safeParse(request.path).success ||
        !pathSegments(request.path),
    )
  )
    return actionFailure('pinned-file-unreadable', 'Pinned file coordinates are incomplete or mixed')

  if (first.cwd !== undefined && (await checkoutRepository(first.cwd)) === first.repository) {
    const local = await localCatalogue(first.cwd, requests)
    if (local !== null) return { ok: true, value: local }
  }

  return readGitHubBlobs(requests)
}

export async function gitTreePaths(cwd: string, commit: string): Promise<Result<readonly string[]>> {
  if (!isGitSha(commit)) return actionFailure('pinned-file-unreadable', 'Tree commit is not a Git object id')
  const listed = await git(cwd, ['ls-tree', '-r', '-z', '--name-only', commit])
  if (!listed.ok) return actionFailure('pinned-file-unreadable', `Cannot list ${commit} in ${cwd}`)
  return { ok: true, value: gitPaths(listed.stdout) }
}

export async function changedPaths(cwd: string, base: string, head: string): Promise<Result<readonly string[]>> {
  if (!isGitSha(base) || !isGitSha(head))
    return actionFailure('action-input-missing', 'Changed paths require Git object ids')
  const diff = await git(cwd, ['diff', '--name-only', '-z', base, head])
  if (!diff.ok) return actionFailure('git-objects-missing', `Pinned Git objects are missing for ${base}..${head}`)
  return { ok: true, value: gitPaths(diff.stdout) }
}

/** Direct two-dot `--binary --full-index`. GitHub three-dot compare media is not this comparison and is not called. */
export async function readPinnedDiff(input: {
  cwd: string
  repository: string
  base: string
  head: string
  gh: Gh
}): Promise<Result<Uint8Array>> {
  void input.gh
  if (!REPOSITORY.test(input.repository) || !isGitSha(input.base) || !isGitSha(input.head)) {
    return actionFailure('action-input-missing', 'Pinned diff requires Git object ids')
  }
  if ((await checkoutRepository(input.cwd)) !== input.repository) {
    return actionFailure(
      'git-objects-missing',
      `Pinned diff requires local Git objects for ${input.repository}@${input.base}..${input.head}`,
    )
  }
  const diff = await git(input.cwd, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--binary',
    '--full-index',
    input.base,
    input.head,
  ])
  if (!diff.ok)
    return actionFailure('git-objects-missing', `Pinned Git objects are missing for ${input.base}..${input.head}`)
  return { ok: true, value: diff.stdout }
}
