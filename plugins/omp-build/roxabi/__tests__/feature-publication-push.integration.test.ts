import { execFile, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { proveAuthorizedBranch } from '../feature-publication.ts'
import type { GitRunner } from '../workflow-checkout.ts'

const run = promisify(execFile)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const git: GitRunner = async (cwd, args) => {
  try {
    const { stdout, stderr } = await run('git', args, { cwd })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    }
  }
}

function gitSync(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim()
}

describe('implementation push against real git', () => {
  it('publishes the verified tip even when a local branch is named like that SHA', async () => {
    const root = mkdtempSync(join(tmpdir(), 'feature-push-'))
    roots.push(root)
    gitSync(root, 'init', '-q', '--bare', 'remote.git')
    const work = join(root, 'work')
    gitSync(root, 'init', '-q', '-b', 'feat/42-save', 'work')
    gitSync(work, 'remote', 'add', 'origin', join(root, 'remote.git'))
    gitSync(work, 'commit', '-q', '--allow-empty', '-m', 'other')
    const other = gitSync(work, 'rev-parse', 'HEAD')
    gitSync(work, 'commit', '-q', '--allow-empty', '-m', 'verified')
    const tip = gitSync(work, 'rev-parse', 'HEAD')
    gitSync(work, '-c', 'advice.objectNameWarning=false', 'branch', tip, other)
    const allowed = async () => ({ ok: true as const })

    const result = await proveAuthorizedBranch(git, work, 'feat/42-save', tip, { effect: allowed, beforePush: allowed })

    expect(result).toEqual({ ok: true, remoteTip: tip })
    expect(gitSync(root, '--git-dir', 'remote.git', 'rev-parse', 'refs/heads/feat/42-save')).toBe(tip)
  })
})
