import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as github from '../../roxabi/feature-engine.ts'
import type { UwOperations } from '../../roxabi/uw-contract.ts'
import { normalizationHandoffFixture } from '../../testing/normalization-handoff-fixture.ts'
import { commandComposition } from './feature-command-fixture.ts'

let root: string | undefined
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

it.each([false, true])(
  'offers initial framing from a real checkout without moving or starting delivery: linked=%s',
  async (linked) => {
    root = mkdtempSync(join(tmpdir(), 'omp-normalization-principal-'))
    const stack = JSON.stringify({ schema_version: '1.0', runtime: 'bun', release: { model: 'trunk' } })
    mkdirSync(join(root, '.dev'))
    writeFileSync(join(root, '.dev', 'stack.yml'), stack)
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com',
    }
    const gitCommand = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' })
    gitCommand('init', '-q', '-b', 'fix/910-principal-normalization-handoff')
    gitCommand('add', '.dev/stack.yml')
    gitCommand('commit', '-q', '-m', 'fixture')
    gitCommand('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
    const cwd = linked ? join(root, 'other') : root
    if (linked) gitCommand('worktree', 'add', '-q', '-b', 'other', cwd)
    // The test runner is Node; the fixture document is JSON, a YAML subset.
    vi.stubGlobal('Bun', { ...globalThis.Bun, YAML: { parse: JSON.parse } })

    const fixture = normalizationHandoffFixture()
    const readGit = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' })
    const worktrees = readGit('worktree', 'list', '--porcelain')
    const branch = readGit('branch', '--show-current')
    vi.spyOn(github, 'defaultGh').mockReturnValue(fixture.gh)
    const command = commandComposition(cwd, {
      principalCwd: () => !linked,
      uwOperations: () => fixture.read as UwOperations,
    })
    await command.run('#910')
    expect(command.framing).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { kind: 'issue', uw: { repository: 'fixture/widgets', target: 'fixture/widgets#910' } },
      expect.any(Function),
    )
    expect(command.sent).toEqual([])
    expect(readGit('worktree', 'list', '--porcelain')).toBe(worktrees)
    expect(readGit('branch', '--show-current')).toBe(branch)
    expect(existsSync(join(root, '.git', 'omp-build-bootstrapped'))).toBe(false)
    expect(fixture.rejected).toEqual([])
  },
)
