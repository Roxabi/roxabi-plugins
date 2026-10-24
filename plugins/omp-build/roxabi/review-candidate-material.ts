import { execFile } from 'node:child_process'

import type { Git, PreparedReviewChunk, ReviewFile } from './review-input-contract'

export type RawChunk = {
  index: number
  delta: string[]
  diff: string
  files: { path: string; oldPath?: string; hunk?: string }[]
  digest: string
}

function requiredGit(git: Git, cwd: string, args: string[], label: string): Promise<string> {
  return git(cwd, args).then((result) => {
    if (result.code !== 0) {
      throw new Error(`${label}: ${result.stderr || result.stdout || 'git command failed'}`)
    }
    return result.stdout
  })
}

export async function candidateText(
  git: Git,
  cwd: string,
  sha: string,
  path: string,
  required: boolean,
): Promise<string | null> {
  const result = await git(cwd, ['show', `${sha}:${path}`])
  if (result.code === 0) return result.stdout
  if (!required) return null
  throw new Error(`candidate blob is unreadable: ${path}: ${result.stderr || result.stdout}`)
}

export async function candidateBinary(
  git: Git,
  cwd: string,
  base: string,
  candidate: string,
  path: string,
): Promise<boolean> {
  const result = await git(cwd, ['diff', '--numstat', base, candidate, '--', path])
  if (result.code !== 0) throw new Error(`candidate binary check failed for ${path}`)
  return result.stdout.startsWith('-\t-\t')
}

async function chunk(rawDiff: string, contextWindow: number, cwd: string, helper: string): Promise<RawChunk[]> {
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  const child = execFile(
    'python3',
    [helper],
    { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    (error, value, stderr) => {
      if (error) {
        reject(new Error(`prepare_context.py failed: ${String(stderr) || error.message}`))
        return
      }
      resolve(String(value))
    },
  )
  child.stdin?.end(JSON.stringify({ rawDiff, contextWindow }))
  const parsed: unknown = JSON.parse(await promise)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('ok' in parsed) ||
    parsed.ok !== true ||
    !('chunks' in parsed) ||
    !Array.isArray(parsed.chunks)
  ) {
    throw new Error('prepare_context.py returned an invalid result')
  }
  return parsed.chunks as RawChunk[]
}

function deletedPaths(nameStatus: string): ReadonlySet<string> {
  const deleted = new Set<string>()
  const fields = nameStatus.split('\0').filter((entry) => entry.length > 0)
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++] ?? ''
    if (status[0] === 'R' || status[0] === 'C') {
      index += 2
      continue
    }
    const path = fields[index++]
    if (status[0] === 'D' && path) deleted.add(path)
  }
  return deleted
}

export async function candidateHasAxialAdr(git: Git, cwd: string, candidate: string): Promise<boolean> {
  const paths = await requiredGit(
    git,
    cwd,
    ['ls-tree', '-r', '--name-only', candidate, '--', 'docs/architecture/adr'],
    'candidate axial ADR discovery',
  )
  for (const path of paths.split('\n')) {
    if (path.endsWith('.md') && /^axial:\s*true/m.test((await candidateText(git, cwd, candidate, path, true)) ?? '')) {
      return true
    }
  }
  return false
}

/** Carries raw diff/chunker/file bytes forward verbatim; no prose reconstruction. */
export async function materializeCandidateChunks(input: {
  cwd: string
  git: Git
  base: string
  candidate: string
  contextWindow: number
  helper: string
}): Promise<PreparedReviewChunk[]> {
  const [rawDiff, nameStatus] = await Promise.all([
    requiredGit(
      input.git,
      input.cwd,
      ['diff', '--no-ext-diff', '--binary', input.base, input.candidate],
      'candidate diff',
    ),
    requiredGit(input.git, input.cwd, ['diff', '--name-status', '-z', input.base, input.candidate], 'candidate status'),
  ])
  const deletions = deletedPaths(nameStatus)
  const chunks = await chunk(rawDiff, input.contextWindow, input.cwd, input.helper)
  return Promise.all(
    chunks.map(async (item) => ({
      index: item.index,
      delta: item.delta,
      diff: item.diff,
      digest: item.digest,
      files: await Promise.all(
        item.files.map(async (file): Promise<ReviewFile> => {
          const deleted = deletions.has(file.path)
          const binary = deleted
            ? false
            : await candidateBinary(input.git, input.cwd, input.base, input.candidate, file.path)
          return {
            path: file.path,
            ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }),
            ...(file.hunk === undefined ? {} : { hunk: file.hunk }),
            text:
              deleted || binary ? null : await candidateText(input.git, input.cwd, input.candidate, file.path, true),
            deleted,
            binary,
          }
        }),
      ),
    })),
  )
}
