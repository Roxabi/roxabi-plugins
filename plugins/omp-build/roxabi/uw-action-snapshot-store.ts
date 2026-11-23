import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Result } from '../engine/result.ts'
import type { ActionSnapshot, ActionSnapshotStore } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'

function linkedWorktreeGitDir(cwd: string): string | null {
  try {
    const gitDir = resolve(
      cwd,
      execFileSync('git', ['-C', cwd, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim(),
    )
    const common = resolve(
      cwd,
      execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim(),
    )
    return gitDir === common ? null : gitDir
  } catch {
    return null
  }
}

function placementRoot(input: {
  artifactsDir?: string | null
  cwd: string
}): Result<{ root: string; location: ActionSnapshot['location'] }> {
  if (input.artifactsDir) {
    const root = join(input.artifactsDir, 'local', 'omp-build', 'actions')
    try {
      mkdirSync(root, { recursive: true, mode: 0o755 })
      return { ok: true, value: { root, location: 'local' } }
    } catch {
      // Fall through to the linked worktree git dir. Never the principal .git.
    }
  }
  const gitDir = linkedWorktreeGitDir(input.cwd)
  if (gitDir === null) {
    return actionFailure(
      'snapshot-placement-unavailable',
      'Neither the local protocol root nor this worktree git dir can hold the action snapshot',
    )
  }
  const root = join(gitDir, 'omp-build', 'actions')
  try {
    mkdirSync(root, { recursive: true, mode: 0o755 })
  } catch (error) {
    return actionFailure(
      'snapshot-placement-unavailable',
      error instanceof Error ? error.message : 'worktree git dir is not writable',
    )
  }
  return { ok: true, value: { root, location: 'worktree-gitdir' } }
}

function writeTree(directory: string, files: readonly { path: string; bytes: Uint8Array }[]): void {
  for (const file of files) {
    const target = join(directory, file.path)
    mkdirSync(dirname(target), { recursive: true, mode: 0o755 })
    writeFileSync(target, file.bytes, { mode: 0o444 })
  }
}

export function createActionSnapshotStore(input: { artifactsDir?: string | null; cwd: string }): ActionSnapshotStore {
  return {
    create: async (request) => {
      const placed = placementRoot(input)
      if (!placed.ok) return placed
      const id = randomBytes(16).toString('hex')
      const directory = join(placed.value.root, `${id}-${request.actionId.replace(/[^a-z0-9-]/gi, '')}`)
      try {
        mkdirSync(directory, { recursive: true, mode: 0o755 })
        writeTree(directory, request.files)
      } catch (error) {
        return actionFailure(
          'snapshot-placement-unavailable',
          error instanceof Error ? error.message : 'snapshot write failed',
        )
      }
      return { ok: true, value: { indexPath: join(directory, 'index.md'), location: placed.value.location } }
    },
  }
}
