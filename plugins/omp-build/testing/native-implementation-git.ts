import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Scope } from '../engine/record-values.ts'
import { defaultGit, prepareFeatureCheckout, verifyParentCheckout } from '../roxabi/workflow-checkout.ts'

/** Real isolated object graph for the production action reader's worktree-HEAD guard. */
export function nativeImplementationGit(firstTicket = 201) {
  const root = mkdtempSync(join(tmpdir(), 'omp-delivery-git-'))
  const cwd = join(root, 'principal')
  const originUrl = join(root, 'origin.git')
  mkdirSync(cwd)
  const worktrees = new Set<string>()
  const runAt = (directory: string, args: string[], input?: string) =>
    execFileSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      input,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture',
        GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'Fixture',
        GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_AUTHOR_DATE: '2026-10-27T12:00:00Z',
        GIT_COMMITTER_DATE: '2026-10-27T12:00:00Z',
      },
    }).trim()
  const run = (args: string[], input?: string) => runAt(cwd, args, input)
  const cleanup = () => {
    try {
      for (const path of worktrees) run(['worktree', 'remove', '--force', path])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
  try {
    run(['init', '--quiet', '--initial-branch=main'])
    run(['init', '--quiet', '--bare', '--initial-branch=main', originUrl])
    const config = run(
      ['hash-object', '-w', '--stdin'],
      `worktree:\n  base: ${JSON.stringify(join(root, 'checkouts'))}\nrelease:\n  model: trunk\n`,
    )
    const configTree = run(['mktree'], `100644 blob ${config}\tstack.yml\n`)
    const tree = (content: string) => {
      const blob = run(['hash-object', '-w', '--stdin'], content)
      return run(['mktree'], `040000 tree ${configTree}\t.dev\n100644 blob ${blob}\tfixture.txt\n`)
    }
    const commit = (content: string, message: string, parents: readonly string[]) =>
      run(['commit-tree', tree(content), ...parents.flatMap((parent) => ['-p', parent]), '-m', message])
    const p0 = commit('base\n', 'fixture base', [])
    const heads: string[] = []
    const merges: string[] = []
    let base = p0
    for (let i = 0; i < 3; i++) {
      const head = commit(`child ${i + 1}\n`, `feat: implement fixture (#${firstTicket + i})`, [base])
      const merge = commit(`child ${i + 1}\n`, `merge child ${i + 1}`, [base, head])
      heads.push(head)
      merges.push(merge)
      base = merge
    }
    const parentHead = commit('parent integration\n', 'feat: integrate children (#200)', [base])
    run(['checkout', '--quiet', '-B', 'main', p0])
    run(['remote', 'add', 'origin', originUrl])
    run(['push', '--quiet', 'origin', `${p0}:refs/heads/main`])
    run(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
    run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
    const publishBase = (sha: string) => {
      run(['push', '--quiet', 'origin', `${sha}:refs/heads/main`])
      run(['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
    }
    const parent = async (uw: Scope) => {
      if (process.env.OMP_WORKTREE_DIR || process.env.OMP_WORKTREE_ROOT)
        throw new Error('Fixture safety: ambient worktree root overrides are not permitted')
      const git = defaultGit()
      const prepared = await prepareFeatureCheckout({
        git,
        sessionCwd: cwd,
        target: { kind: 'parent', uw },
        base: 'main',
        repository: uw.repository,
      })
      if (prepared.status === 'blocked') throw new Error(`Parent checkout refused: ${prepared.reason}`)
      const path = prepared.status === 'move' ? prepared.path : prepared.cwd
      worktrees.add(path)
      const verified = await verifyParentCheckout({ git, cwd: path, uw })
      if (!verified.ok) throw new Error(`Parent checkout invalid: ${verified.reason}`)
      const observe = () => {
        runAt(verified.cwd, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'])
        const head = runAt(verified.cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
        const branch = runAt(verified.cwd, ['branch', '--show-current'])
        const baseTip = runAt(verified.cwd, ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'])
        const remote = runAt(verified.cwd, ['ls-remote', 'origin', 'refs/heads/main'])
        const remoteTip = remote.split(/\s+/)[0]
        if (!remoteTip || !/^[a-f0-9]{40}$/.test(remoteTip)) throw new Error('Published base is unavailable')
        return { branch: branch === '' ? null : branch, head, base: 'main', baseTip, remoteTip }
      }
      return {
        cwd: verified.cwd,
        checkout: (sha: string) => {
          if (runAt(verified.cwd, ['status', '--porcelain']) !== '') throw new Error('Parent checkout is dirty')
          runAt(verified.cwd, ['checkout', '--quiet', '--detach', sha])
        },
        observe,
        tree: (sha: string) => runAt(verified.cwd, ['rev-parse', `${sha}^{tree}`]),
      }
    }
    const checkout = (sha: string) => {
      run(['checkout', '--quiet', '--detach', '--force', sha])
    }
    return {
      cwd,
      originUrl,
      parent,
      publishBase,
      p0,
      heads,
      merges,
      parentHead,
      checkout,
      tree: (sha: string) => run(['rev-parse', `${sha}^{tree}`]),
      diff: (base: string, head: string) => new Uint8Array(execFileSync('git', ['-C', cwd, 'diff', base, head])),
      cleanup,
    }
  } catch (error) {
    cleanup()
    throw error
  }
}
