import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Gh } from '../adapters/github/types.ts'
import { repoRelativePathSchema } from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import { actionFailure, isGitSha } from './uw-action-result.ts'
import { readGitHubBlob } from './uw-github-blobs.ts'

const execFileAsync = promisify(execFile)
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export type GitByteRequest = {
  repository: string
  commit: string
  path: string
  cwd?: string
  gh: Gh
}

export function githubRepository(url: string): string | null {
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
