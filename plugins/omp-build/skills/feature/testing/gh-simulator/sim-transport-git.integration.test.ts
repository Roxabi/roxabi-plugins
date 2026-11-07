import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeSimCommand } from './sim-execution.ts'
import { base, dispose, openState, pull, run, saved } from './sim-transport-fixture.ts'

const CLI = join(import.meta.dirname, 'gh-simulator.ts')

function git(cwd: string, args: string[]): string {
  const out = spawnSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.hooksPath=/dev/null', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  )
  if (out.status !== 0) throw new Error(out.stderr || out.stdout)
  return out.stdout.trim()
}

function originWith(branches: Record<string, string>): { root: string; origin: string; shas: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), 'omp-sim-git-'))
  const repo = join(root, 'src')
  const origin = join(root, 'origin.git')
  git(root, ['init', '-q', '-b', 'main', repo])
  git(root, ['init', '-q', '--bare', origin])
  writeFileSync(join(repo, 'README.md'), 'base\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-qm', 'base'])
  git(repo, ['remote', 'add', 'origin', origin])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])
  const shas: Record<string, string> = {}
  for (const [branch, body] of Object.entries(branches)) {
    git(repo, ['switch', '-q', '-C', branch, 'refs/remotes/origin/main'])
    writeFileSync(join(repo, 'README.md'), body)
    git(repo, ['add', 'README.md'])
    git(repo, ['commit', '-qm', branch])
    git(repo, ['push', '-q', '-u', 'origin', branch])
    shas[branch] = git(repo, ['rev-parse', 'HEAD'])
  }
  return { root, origin, shas }
}

function green() {
  return [
    { name: 'ci', status: 'completed', conclusion: 'success', workflowName: 'ci', startedAt: '2026-01-01T00:00:00Z' },
  ]
}

describe('simulator transport git effects', () => {
  it('keeps scoped native worlds and real Git effects isolated without changing ambient environment', () => {
    const leftGit = originWith({ 'feat/a': 'left world\n' })
    const rightGit = originWith({ 'feat/a': 'right world\n' })
    const leftSha = leftGit.shas['feat/a']
    const rightSha = rightGit.shas['feat/a']
    if (leftSha === undefined || rightSha === undefined) throw new Error('fixture branch commits missing')
    const left = openState(
      base({
        origin: leftGit.origin,
        requiredChecks: ['ci'],
        checks: { [leftSha]: green() },
        prs: {
          10: pull(10, 'feat/a', leftSha, {
            labels: ['reviewed'],
            autoMerge: { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: leftSha },
          }),
        },
      }),
    )
    const right = openState(
      base({
        origin: rightGit.origin,
        requiredChecks: ['ci'],
        checks: { [rightSha]: green() },
        prs: { 10: pull(10, 'feat/a', rightSha, { labels: ['reviewed'] }) },
      }),
    )
    const ambient = { ...process.env }
    const invoke = (box: typeof left, args: string[]) =>
      executeSimCommand(args, {
        cwd: box.root,
        env: { ...process.env, GH_SIM_STATE: box.file, HOME: box.root, PATH: `${box.root}:${process.env.PATH ?? ''}` },
        readStdin: () => '',
      })
    try {
      const rightBase = git(rightGit.origin, ['rev-parse', 'refs/heads/main'])
      expect(invoke(left, ['pr', 'view', '10']).status).toBe(0)
      const merged = saved(left.file).prs['10']
      expect(merged?.state).toBe('MERGED')
      expect(merged?.mergeCommit?.parents[1]).toBe(leftSha)
      expect(git(leftGit.origin, ['rev-parse', 'refs/heads/main^2'])).toBe(leftSha)
      const wrong = invoke(right, ['pr', 'merge', '10', '--auto', '--merge', '--match-head-commit', leftSha])
      expect(wrong.status).toBe(1)
      expect(wrong.stderr).toContain('match-head-commit')
      expect(saved(right.file).prs['10']).toMatchObject({ state: 'OPEN', autoMerge: null })
      expect(git(rightGit.origin, ['rev-parse', 'refs/heads/main'])).toBe(rightBase)
      expect(invoke(right, ['pr', 'merge', '10', '--auto', '--merge', '--match-head-commit', rightSha]).status).toBe(0)
      expect(invoke(right, ['pr', 'view', '10']).status).toBe(0)
      expect(saved(right.file).prs['10']?.mergeCommit?.parents[1]).toBe(rightSha)
      expect(git(rightGit.origin, ['rev-parse', 'refs/heads/main^2'])).toBe(rightSha)
      expect(saved(left.file).prs['10']?.mergeCommit?.parents[1]).toBe(leftSha)
      expect({ ...process.env }).toEqual(ambient)
    } finally {
      dispose(left.root)
      dispose(right.root)
      dispose(leftGit.root)
      dispose(rightGit.root)
    }
  })

  it('refuses a wrong pin and an already-enabled pin without merging', () => {
    const gitBox = originWith({ 'feat/a': 'left\n' })
    const sha = gitBox.shas['feat/a']
    const box = openState(
      base({
        origin: gitBox.origin,
        checks: { [sha]: green() },
        prs: { 10: pull(10, 'feat/a', sha, { labels: ['reviewed'] }) },
      }),
    )
    try {
      const wrong = run(
        box.file,
        ['pr', 'merge', '10', '--auto', '--merge', '--match-head-commit', 'b'.repeat(40)],
        box.root,
      )
      expect(wrong.status).toBe(1)
      expect(wrong.stderr).toContain('match-head-commit')
      expect(saved(box.file).prs['10']).toMatchObject({ state: 'OPEN', autoMerge: null })
      const armed = saved(box.file)
      armed.prs['10'].autoMerge = { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: sha }
      writeFileSync(box.file, JSON.stringify(armed, null, 2))
      const again = run(box.file, ['pr', 'merge', '10', '--auto', '--merge', '--match-head-commit', sha], box.root)
      expect(again.status).toBe(1)
      expect(again.stderr).toContain('auto-merge already enabled')
      expect(saved(box.file).prs['10'].state).toBe('OPEN')
    } finally {
      dispose(box.root)
      dispose(gitBox.root)
    }
  })

  it('merges an armed pull and records the real second parent', () => {
    const gitBox = originWith({ 'feat/a': 'left\n' })
    const sha = gitBox.shas['feat/a']
    const box = openState(
      base({
        origin: gitBox.origin,
        requiredChecks: ['ci'],
        checks: { [sha]: green() },
        prs: {
          10: pull(10, 'feat/a', sha, {
            labels: ['reviewed'],
            autoMerge: { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: sha },
          }),
        },
      }),
    )
    try {
      const result = run(box.file, ['pr', 'view', '10'], box.root)
      const pr = saved(box.file).prs['10']
      expect(result.status).toBe(0)
      expect(pr).toBeDefined()
      if (pr === undefined) throw new Error('armed pull missing after view')
      expect(pr.state).toBe('MERGED')
      const merge = pr.mergeCommit
      expect(merge).not.toBeNull()
      if (merge === null) throw new Error('armed merge did not record a merge commit')
      expect(merge.parents).toHaveLength(2)
      expect(merge.parents[1]).toBe(sha)
      expect(git(gitBox.origin, ['rev-parse', `${merge.oid}^2`])).toBe(sha)
      expect(git(gitBox.origin, ['rev-parse', `${merge.oid}^1`])).toBe(merge.parents[0])
      expect(existsSync(join(tmpdir(), `gh-sim-merge-10-${process.pid}`))).toBe(false)
    } finally {
      dispose(box.root)
      dispose(gitBox.root)
    }
  })

  it('keeps a completed merge when the view response jq fails', () => {
    const gitBox = originWith({ 'feat/a': 'left\n' })
    const sha = gitBox.shas['feat/a']
    const box = openState(
      base({
        origin: gitBox.origin,
        requiredChecks: ['ci'],
        checks: { [sha]: green() },
        prs: {
          10: pull(10, 'feat/a', sha, {
            labels: ['reviewed'],
            autoMerge: { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: sha },
          }),
        },
      }),
    )
    try {
      const result = run(box.file, ['pr', 'view', '10', '--json', 'state', '--jq', 'error("after-merge")'], box.root)
      const pr = saved(box.file).prs['10']
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('Command failed: jq')
      expect(result.stderr).toContain('after-merge')
      expect(pr).toBeDefined()
      if (pr === undefined) throw new Error('armed pull missing after failed view')
      expect(pr.state).toBe('MERGED')
      const merge = pr.mergeCommit
      expect(merge).not.toBeNull()
      if (merge === null) throw new Error('failed view rolled back the merge commit')
      expect(merge.parents[1]).toBe(sha)
      expect(git(gitBox.origin, ['rev-parse', `${merge.oid}^2`])).toBe(sha)
      expect(git(gitBox.origin, ['rev-parse', `${merge.oid}^1`])).toBe(merge.parents[0])
    } finally {
      dispose(box.root)
      dispose(gitBox.root)
    }
  })

  it('keeps the first sibling merge when the second conflicts', () => {
    const gitBox = originWith({ 'feat/10-a': 'left\n', 'feat/11-b': 'right\n' })
    const first = gitBox.shas['feat/10-a']
    const second = gitBox.shas['feat/11-b']
    const box = openState(
      base({
        origin: gitBox.origin,
        requiredChecks: ['ci'],
        checks: { [first]: green(), [second]: green() },
        prs: {
          10: pull(10, 'feat/10-a', first, {
            labels: ['reviewed'],
            autoMerge: { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: first },
          }),
          11: pull(11, 'feat/11-b', second, {
            labels: ['reviewed'],
            autoMerge: { enabledAt: '2026-01-01T00:00:00Z', matchHeadCommit: second },
          }),
        },
      }),
    )
    try {
      const result = run(box.file, ['pr', 'list'], box.root)
      const state = saved(box.file)
      expect(result.status).toBe(0)
      expect(state.prs['10'].state).toBe('MERGED')
      expect(state.prs['11'].state).toBe('OPEN')
      expect(git(gitBox.origin, ['rev-parse', 'refs/heads/main^2'])).toBe(first)
    } finally {
      dispose(box.root)
      dispose(gitBox.root)
    }
  })

  it('keeps both barrier comments when a second process waits for the lock', async () => {
    const box = openState(
      base({
        issues: {
          1: {
            number: 1,
            title: 'epic',
            body: 'x',
            state: 'OPEN',
            updatedAt: '2026-01-01T00:00:00Z',
            author: 'operator',
            labels: [],
            comments: [],
            subIssues: [],
            blockedBy: [],
          },
        },
      }),
    )
    const started = join(box.root, 'started')
    const release = join(box.root, 'release')
    const bun = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim()
    const env = {
      ...process.env,
      GH_SIM_STATE: box.file,
      GH_SIM_COMMENT_BARRIER_MATCH: 'hold-comment',
      GH_SIM_COMMENT_BARRIER_STARTED: started,
      GH_SIM_COMMENT_BARRIER_RELEASE: release,
    }
    const first = spawn(
      bun,
      [CLI, 'api', '--method', 'POST', 'repos/acme/app/issues/1/comments', '-f', 'body=hold-comment'],
      { env },
    )
    const entered = Promise.withResolvers<void>()
    const watcher = watch(box.root, () => {
      if (!existsSync(started)) return
      watcher.close()
      entered.resolve()
    })
    if (existsSync(started)) {
      watcher.close()
      entered.resolve()
    }
    await entered.promise
    const second = spawn(
      bun,
      [CLI, 'api', '--method', 'POST', 'repos/acme/app/issues/1/comments', '-f', 'body=second-comment'],
      {
        env: { ...process.env, GH_SIM_STATE: box.file },
      },
    )
    writeFileSync(release, 'go\n')
    const firstExit = Promise.withResolvers<number | null>()
    const secondExit = Promise.withResolvers<number | null>()
    first.once('exit', firstExit.resolve)
    second.once('exit', secondExit.resolve)
    const codes = await Promise.all([firstExit.promise, secondExit.promise])
    try {
      const comments = saved(box.file).issues['1'].comments
      expect(codes).toEqual([0, 0])
      expect(comments.map((comment) => comment.body)).toEqual(['hold-comment', 'second-comment'])
      expect(comments).toHaveLength(2)
      const [hold, next] = comments
      expect(hold).toBeDefined()
      expect(next).toBeDefined()
      if (hold === undefined || next === undefined) throw new Error('barrier comments missing')
      expect(hold.id).toEqual(expect.any(Number))
      expect(next.id).toEqual(expect.any(Number))
      expect(hold.id).not.toBe(next.id)
      expect(existsSync(`${box.file}.lock`)).toBe(false)
    } finally {
      watcher.close()
      first.kill()
      second.kill()
      dispose(box.root)
    }
  })
})
