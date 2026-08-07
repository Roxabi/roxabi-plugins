import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)

type GitInject = {
  execFileSync?: (...args: never[]) => string
}

const freeze = require('../lib/principal-freeze.cjs') as {
  isBaseBranch: (n: string | null | undefined) => boolean
  hasEscapeHatch: (env?: NodeJS.ProcessEnv) => boolean
  isPrincipalCwd: (cwd: string, git?: GitInject) => boolean
  principalHead: (
    cwd?: string,
    git?: GitInject,
  ) => { status: 'ok'; principal: string; branch: string } | { status: 'not_git' } | { status: 'probe_error' }
  gitProbeEnv: () => NodeJS.ProcessEnv
}

const pre = require('../principal-branch-pre.cjs') as {
  matchHighTrafficBranchMove: (cmd: string) => { target: string } | null
  shouldDenyPre: (cmd: string, cwd: string, deps?: { isPrincipalCwd?: (c: string) => boolean }) => boolean
}

const post = require('../principal-branch-post.cjs') as {
  assertPrincipalOnBase: (
    cwd?: string,
    deps?: {
      principalHead?: (c?: string) => unknown
    },
  ) => {
    ok: boolean
    branch?: string
    reason?: string
    status?: string
  }
}

const principal = '/repo/principal'
const featureWt = '/repo/feature-wt'

function mockGit(map: {
  topLevel: Record<string, string | null>
  principal: string | null
  branchByPath?: Record<string, string>
  /** cwd keys that throw non-not-git errors */
  probeError?: string[]
}): GitInject {
  return {
    execFileSync: ((...a: never[]) => {
      const args = a[1] as string[]
      const cIdx = args.indexOf('-C')
      const cwd = cIdx >= 0 ? (args[cIdx + 1] as string) : '.'
      const rest = cIdx >= 0 ? args.slice(cIdx + 2).map(String) : args.map(String)

      if (map.probeError?.includes(cwd)) {
        const err = new Error('fatal: lock held') as Error & { stderr: string }
        err.stderr = 'fatal: lock held'
        throw err
      }

      if (rest[0] === 'rev-parse' && rest[1] === '--show-toplevel') {
        const v = map.topLevel[cwd]
        if (v == null) {
          const err = new Error('fatal: not a git repository') as Error & { stderr: string }
          err.stderr = 'fatal: not a git repository (or any of the parent directories): .git'
          throw err
        }
        return `${v}\n`
      }
      if (rest[0] === 'rev-parse' && rest[1] === '--abbrev-ref') {
        const b = map.branchByPath?.[cwd] ?? map.branchByPath?.[map.principal || '']
        if (!b) {
          const err = new Error('fatal: lock held') as Error & {
            stderr: string
          }
          err.stderr = 'fatal: lock held'
          throw err
        }
        return `${b}\n`
      }
      if (rest[0] === 'worktree' && rest[1] === 'list') {
        if (!map.principal) {
          const err = new Error('fatal: not a git repository') as Error & { stderr: string }
          err.stderr = 'fatal: not a git repository'
          throw err
        }
        return `worktree ${map.principal}\nHEAD abc\nbranch refs/heads/main\n`
      }
      throw new Error(`unexpected ${rest.join(' ')}`)
    }) as GitInject['execFileSync'],
  }
}

describe('isBaseBranch', () => {
  it('accepts β only', () => {
    expect(freeze.isBaseBranch('main')).toBe(true)
    expect(freeze.isBaseBranch('staging')).toBe(true)
    expect(freeze.isBaseBranch('master')).toBe(true)
    expect(freeze.isBaseBranch('origin/main')).toBe(true)
    expect(freeze.isBaseBranch('feat/x')).toBe(false)
    expect(freeze.isBaseBranch('HEAD')).toBe(false)
    expect(freeze.isBaseBranch(null)).toBe(false)
  })
})

describe('hasEscapeHatch', () => {
  it('only exact 1', () => {
    expect(freeze.hasEscapeHatch({ DEV_CORE_ALLOW_PRINCIPAL_SWITCH: '1' })).toBe(true)
    expect(freeze.hasEscapeHatch({ DEV_CORE_ALLOW_PRINCIPAL_SWITCH: 'true' })).toBe(false)
    expect(freeze.hasEscapeHatch({})).toBe(false)
  })
})

describe('gitProbeEnv', () => {
  it('strips GIT_DIR and GIT_WORK_TREE', () => {
    const prevDir = process.env.GIT_DIR
    const prevWt = process.env.GIT_WORK_TREE
    process.env.GIT_DIR = '/decoy/.git'
    process.env.GIT_WORK_TREE = '/decoy'
    try {
      const env = freeze.gitProbeEnv()
      expect(env.GIT_DIR).toBeUndefined()
      expect(env.GIT_WORK_TREE).toBeUndefined()
    } finally {
      if (prevDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = prevDir
      if (prevWt === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = prevWt
    }
  })
})

describe('principal state helpers', () => {
  it('isPrincipalCwd and principalHead from principal and feature wt', () => {
    const git = mockGit({
      topLevel: { [principal]: principal, [featureWt]: featureWt },
      principal,
      branchByPath: { [principal]: 'main' },
    })
    expect(freeze.isPrincipalCwd(principal, git)).toBe(true)
    expect(freeze.isPrincipalCwd(featureWt, git)).toBe(false)
    expect(freeze.principalHead(principal, git)).toEqual({
      status: 'ok',
      principal,
      branch: 'main',
    })
    // from feature wt, still reports principal branch
    expect(freeze.principalHead(featureWt, git)).toEqual({
      status: 'ok',
      principal,
      branch: 'main',
    })
  })

  it('principalHead not_git vs probe_error', () => {
    const notGit = mockGit({
      topLevel: {},
      principal: null,
    })
    expect(freeze.principalHead('/tmp', notGit)).toEqual({ status: 'not_git' })

    const errGit = mockGit({
      topLevel: { [principal]: principal },
      principal,
      branchByPath: { [principal]: 'main' },
      probeError: [principal],
    })
    expect(freeze.principalHead(principal, errGit).status).toBe('probe_error')
  })
})

describe('pre: matchHighTrafficBranchMove', () => {
  it('matches switch / checkout -b / branch -M / stash branch', () => {
    expect(pre.matchHighTrafficBranchMove('git switch feat/x')?.target).toBe('feat/x')
    expect(pre.matchHighTrafficBranchMove('git switch main')?.target).toBe('main')
    expect(pre.matchHighTrafficBranchMove('git checkout -b feat/new')?.target).toBe('feat/new')
    expect(pre.matchHighTrafficBranchMove('git branch -M feat/rename')?.target).toBe('feat/rename')
    expect(pre.matchHighTrafficBranchMove('git stash branch feat/s')?.target).toBe('feat/s')
  })

  it('ignores path restore, file.ext checkout, reset --hard, non-git', () => {
    expect(pre.matchHighTrafficBranchMove('git checkout -- file.ts')).toBe(null)
    expect(pre.matchHighTrafficBranchMove('git checkout file.ts')).toBe(null)
    expect(pre.matchHighTrafficBranchMove('git reset --hard HEAD~1')).toBe(null)
    expect(pre.matchHighTrafficBranchMove('bun run test')).toBe(null)
    expect(pre.matchHighTrafficBranchMove('git status')).toBe(null)
  })
})

describe('pre: shouldDenyPre', () => {
  it('denies non-base switch only on principal', () => {
    expect(
      pre.shouldDenyPre('git switch feat/x', principal, {
        isPrincipalCwd: (c) => c === principal,
      }),
    ).toBe(true)
    expect(
      pre.shouldDenyPre('git switch feat/x', featureWt, {
        isPrincipalCwd: (c) => c === principal,
      }),
    ).toBe(false)
    expect(
      pre.shouldDenyPre('git switch main', principal, {
        isPrincipalCwd: (c) => c === principal,
      }),
    ).toBe(false)
  })

  it('does not pre-deny reset --hard (branch may stay β)', () => {
    expect(
      pre.shouldDenyPre('git reset --hard HEAD~1', principal, {
        isPrincipalCwd: () => true,
      }),
    ).toBe(false)
  })

  it('soft-matches git switch even inside bash -c when substring present', () => {
    expect(
      pre.shouldDenyPre("bash -c 'git switch feat/x'", principal, {
        isPrincipalCwd: () => true,
      }),
    ).toBe(true)
    expect(
      pre.shouldDenyPre("node -e \"require('fs').readFileSync('/tmp/x')\"", principal, { isPrincipalCwd: () => true }),
    ).toBe(false)
  })
})

describe('post: assertPrincipalOnBase', () => {
  it('ok when principal on main', () => {
    const r = post.assertPrincipalOnBase(principal, {
      principalHead: () => ({
        status: 'ok',
        principal,
        branch: 'main',
      }),
    })
    expect(r.ok).toBe(true)
  })

  it('fails when principal on feat (state detect — closes script/node holes)', () => {
    const r = post.assertPrincipalOnBase(principal, {
      principalHead: () => ({
        status: 'ok',
        principal,
        branch: 'feat/evil',
      }),
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('feat/evil')
    expect(r.reason).not.toContain('DEV_CORE_ALLOW')
  })

  it('ok when not a git repo', () => {
    const r = post.assertPrincipalOnBase('/tmp', {
      principalHead: () => ({ status: 'not_git' }),
    })
    expect(r.ok).toBe(true)
  })

  it('fail-closed on probe_error', () => {
    const r = post.assertPrincipalOnBase(principal, {
      principalHead: () => ({ status: 'probe_error' }),
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe('probe_error')
    expect(r.reason).toContain('probe failed')
  })

  it('fails on detached HEAD', () => {
    const r = post.assertPrincipalOnBase(principal, {
      principalHead: () => ({
        status: 'ok',
        principal,
        branch: 'HEAD',
      }),
    })
    expect(r.ok).toBe(false)
  })

  it('accepts legacy {principal,branch} inject from tests', () => {
    const r = post.assertPrincipalOnBase(principal, {
      principalHead: () => ({ principal, branch: 'feat/x' }),
    })
    expect(r.ok).toBe(false)
  })
})
