import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeEpicPullRequest } from '../../adapters/github-native/epic-children.ts'
import { disarmKnownTarget } from '../../roxabi/feature-disarm.ts'
import { armedPullRequests } from './epic-driver-github.ts'
import * as epicRuntime from './epic-driver-runtime.ts'
import authorization from './head-authorization.cjs'
import { runHeadAuthorization } from './head-authorization-cli.js'
import { disarmReviewedBeforePush } from './landing-foundation.js'
import { base, dispose, openState, pull, run, saved } from './testing/gh-simulator/sim-transport-fixture.ts'
import type { State } from './testing/gh-simulator/sim-types.ts'
import { enforceArmedGate, readGate } from './workflow-gate.js'
import { applyCiWatchExit } from './workflow-watch.js'

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const PREFIX = '<!-- kit-head-authorization:v1 -->\n'

afterEach(() => vi.unstubAllEnvs())

function fixture() {
  vi.stubEnv('HEAD_AUTH_REPOSITORY_ID', '1')
  vi.stubEnv('HEAD_AUTH_OPERATOR_IDS', '[101]')
  vi.stubEnv('HEAD_AUTH_APP_ID', '200')
  vi.stubEnv('HEAD_AUTH_BOT_USER_ID', '201')
  const box = openState(
    base({ remoteRefs: { main: BASE }, prs: { 10: pull(10, 'feature', HEAD, { baseRefOid: BASE }) } }),
  )
  const gh = async (_cwd: string, args: string[]) => {
    const result = run(box.file, args, box.root)
    if (result.status) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const policy = authorization.policyFromEnv(process.env)
  const args = { cwd: box.root, gh, prNumber: 10, policy }
  const update = (change: (state: State) => void) => {
    const state = saved(box.file)
    change(state)
    writeFileSync(box.file, JSON.stringify(state))
  }
  const grant = async (operationId: string) => {
    const snapshot = await authorization.captureAuthorization(args)
    return authorization.issueAuthorization({
      ...args,
      snapshot,
      lane: 'reviewed',
      source: 'native',
      evidence: 'review:fixture',
      operationId,
    })
  }
  return { ...box, gh, args, update, grant }
}
it('does not publish a manual grant when withdrawal crosses slow admission', async () => {
  const f = fixture()
  try {
    await expect(
      runHeadAuthorization(['issue-manual', '--pr', '10', '--head', HEAD, '--evidence', 'human:review'], {
        cwd: f.root,
        gh: f.gh,
        operationId: () => 'stale-manual',
        readHistory: async () => {
          await authorization.withdrawAuthorization({ ...f.args, operationId: 'concurrent-stop', reason: 'stop' })
          return { source: { complete: true, diagnostics: [] }, diagnostics: [], operations: [] }
        },
      }),
    ).rejects.toThrow()
    const authority = await authorization.readAuthorization(f.args)
    expect(authority.allowed).toBe(false)
    expect(authority.receipt?.record?.kind).toBe('withdraw')
    const comments = saved(f.file).prs['10'].comments.filter((comment) => comment.body.startsWith(PREFIX))
    expect(comments.some((comment) => JSON.parse(comment.body.slice(PREFIX.length)).kind === 'grant')).toBe(false)
  } finally {
    dispose(f.root)
  }
})

it('withdraws a manual grant accepted before an uncertain readback', async () => {
  const f = fixture()
  try {
    let accepted = false
    let failedReadback = false
    const gh = async (cwd: string, args: string[]) => {
      if (accepted && !failedReadback && args.includes('--include') && args.some((arg) => arg.includes('/comments?'))) {
        failedReadback = true
        throw new Error('temporary comment read failure')
      }
      const result = await f.gh(cwd, args)
      if (args.includes('POST') && args.some((arg) => arg.includes('"kind":"grant"'))) accepted = true
      return result
    }
    await expect(
      runHeadAuthorization(['issue-manual', '--pr', '10', '--head', HEAD, '--evidence', 'human:review'], {
        cwd: f.root,
        gh,
        operationId: () => 'uncertain-manual',
        readHistory: async () => ({ source: { complete: true, diagnostics: [] }, diagnostics: [], operations: [] }),
      }),
    ).rejects.toThrow()
    expect(accepted && failedReadback).toBe(true)
    const authority = await authorization.readAuthorization(f.args)
    expect(authority.allowed).toBe(false)
    expect(authority.receipt?.record?.kind).toBe('withdraw')
  } finally {
    dispose(f.root)
  }
})

it.each(['issue', 'pull-request'] as const)(
  'fences a closed unmerged PR through %s control discovery',
  async (kind) => {
    const f = fixture()
    try {
      await f.grant('control-grant')
      f.update((state) => {
        state.prs['10'].state = 'CLOSED'
        state.prs['10'].closes = [42]
      })
      const snapshot = await authorization.captureAuthorization(f.args)
      const target =
        kind === 'issue'
          ? {
              status: 'issue' as const,
              scope: { repository: 'acme/app', target: 'acme/app#42' },
              issue: { number: 42 },
            }
          : {
              status: 'pull-request' as const,
              scope: { repository: 'acme/app', target: 'acme/app#10' },
              pullRequest: { pr: 10 },
            }
      expect(await disarmKnownTarget(f.gh, f.root, target, 'fix-only')).toMatchObject({ clean: true })
      expect((await authorization.readAuthorization(f.args)).allowed).toBe(false)
      await expect(
        authorization.issueAuthorization({
          ...f.args,
          snapshot,
          lane: 'reviewed',
          source: 'native',
          evidence: 'review:stale',
          operationId: 'late-control',
        }),
      ).rejects.toThrow()
    } finally {
      dispose(f.root)
    }
  },
)

it.each([0, 4])('fences an in-flight grant on stopped watcher exit %s without an existing arm', async (code) => {
  const f = fixture()
  try {
    const snapshot = await authorization.captureAuthorization(f.args)
    expect((await applyCiWatchExit(f.root, 10, code, { gh: f.gh })).status).toBe('stopped')
    expect((await authorization.readAuthorization(f.args)).allowed).toBe(false)
    await expect(
      authorization.issueAuthorization({
        ...f.args,
        snapshot,
        lane: 'reviewed',
        source: 'native',
        evidence: 'review:old',
        operationId: 'late',
      }),
    ).rejects.toThrow()
  } finally {
    dispose(f.root)
  }
})

it('withdraws a closed unmerged PR before confirming disarm and rejects a delayed grant', async () => {
  const f = fixture()
  try {
    await f.grant('closed-grant')
    f.update((state) => {
      state.prs['10'].state = 'CLOSED'
    })
    const snapshot = await authorization.captureAuthorization(f.args)
    await disarmReviewedBeforePush(f.root, 10, { gh: f.gh })
    expect((await authorization.readAuthorization(f.args)).allowed).toBe(false)
    await expect(
      authorization.issueAuthorization({
        ...f.args,
        snapshot,
        lane: 'reviewed',
        source: 'native',
        evidence: 'review:old',
        operationId: 'late-closed',
      }),
    ).rejects.toThrow()
    f.update((state) => {
      state.prs['10'].state = 'OPEN'
    })
    expect((await authorization.readAuthorization(f.args)).allowed).toBe(false)
  } finally {
    dispose(f.root)
  }
})

it('distinguishes a merged PR from an unmerged stop', async () => {
  const f = fixture()
  try {
    f.update((state) => {
      state.prs['10'].state = 'MERGED'
    })
    expect(await disarmReviewedBeforePush(f.root, 10, { gh: f.gh })).toMatchObject({ merged: true })
    expect(saved(f.file).prs['10'].comments).toEqual([])
  } finally {
    dispose(f.root)
  }
})

describe('native authorization against GitHub-shaped transport', () => {
  it('recognizes an authorized Epic head even without a reviewed label', async () => {
    const f = fixture()
    try {
      await f.grant('epic-valid')
      vi.spyOn(epicRuntime, 'gh').mockImplementation((cwd, args) => {
        const result = run(f.file, args, cwd)
        if (result.status) throw new Error(result.stderr)
        return result.stdout.trim()
      })
      const pr = {
        number: 10,
        state: 'OPEN',
        headRefOid: HEAD,
        repository: { nameWithOwner: 'acme/app' },
        autoMergeRequest: null,
      } as NativeEpicPullRequest
      expect(await armedPullRequests(f.root, [pr])).toEqual(new Set([10]))
      await expect(armedPullRequests(f.root, [{ ...pr, headRefOid: 'c'.repeat(40) }])).rejects.toThrow('head changed')
    } finally {
      vi.restoreAllMocks()
      dispose(f.root)
    }
  })
  it('runs the manual CLI through real gh-shaped commands and reads its receipt back', async () => {
    const f = fixture()
    try {
      const bin = join(f.root, 'bin')
      mkdirSync(bin)
      const executable = join(bin, 'gh')
      const simulator = join(import.meta.dirname, 'testing/gh-simulator/gh-simulator.ts')
      writeFileSync(executable, `#!/bin/sh\nexec bun '${simulator}' "$@"\n`)
      chmodSync(executable, 0o755)
      const cli = join(import.meta.dirname, 'head-authorization-cli.js')
      const result = spawnSync(
        'bun',
        [cli, 'issue-manual', '--pr', '10', '--head', HEAD, '--evidence', 'review:human'],
        {
          cwd: f.root,
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_SIM_STATE: f.file },
        },
      )
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout).record).toMatchObject({
        kind: 'grant',
        source: 'manual',
        headSha: HEAD,
        evidence: 'review:human',
      })
      expect((await authorization.readAuthorization(f.args)).allowed).toBe(true)
    } finally {
      dispose(f.root)
    }
  })

  it('retains an admitted receipt without the display label and withdraws before push', async () => {
    const f = fixture()
    try {
      await f.grant('native-valid')
      expect(saved(f.file).prs['10'].labels).toEqual([])
      const gate = await readGate(f.root, 10, f.gh)
      expect(gate.authorization?.allowed).toBe(true)
      let pushed = false
      await disarmReviewedBeforePush(f.root, 10, {
        gh: f.gh,
        push: () => {
          const comments = saved(f.file).prs['10'].comments
          const last = comments.at(-1)
          if (!last) throw new Error('withdrawal comment missing')
          expect(JSON.parse(last.body.slice(PREFIX.length)).kind).toBe('withdraw')
          pushed = true
        },
      })
      expect(pushed).toBe(true)
      expect((await authorization.readAuthorization(f.args)).allowed).toBe(false)
    } finally {
      dispose(f.root)
    }
  })

  it('does not grant an admission captured for an old head', async () => {
    const f = fixture()
    try {
      const snapshot = await authorization.captureAuthorization(f.args)
      f.update((state) => {
        state.prs['10'].headRefOid = 'c'.repeat(40)
      })
      await expect(
        authorization.issueAuthorization({
          ...f.args,
          snapshot,
          lane: 'reviewed',
          source: 'native',
          evidence: 'review:old',
          operationId: 'stale',
        }),
      ).rejects.toThrow()
      expect(saved(f.file).prs['10'].comments).toEqual([])
    } finally {
      dispose(f.root)
    }
  })

  it('does not let a prior head authorize a later head even if the label remains', async () => {
    const f = fixture()
    try {
      await f.grant('head-a')
      f.update((state) => {
        state.prs['10'].headRefOid = 'c'.repeat(40)
        state.prs['10'].labels = ['reviewed']
      })
      expect((await authorization.readAuthorization(f.args)).allowed).toBe(false)
    } finally {
      dispose(f.root)
    }
  })

  it('holds an edited receipt even when REST timestamps still match', async () => {
    const f = fixture()
    try {
      await f.grant('edited')
      f.update((state) => {
        state.prs['10'].comments[0].lastEditedAt = '2026-01-02T00:00:00Z'
      })
      expect((await authorization.readAuthorization(f.args)).allowed).toBe(false)
    } finally {
      dispose(f.root)
    }
  })

  it('finds authorization after more than one page of ordinary comments', async () => {
    const f = fixture()
    try {
      f.update((state) => {
        state.prs['10'].comments = Array.from({ length: 101 }, (_, index) => ({
          id: index + 1,
          author: 'operator',
          body: `ordinary ${index}`,
        }))
        state.nextCommentId = 101
      })
      await f.grant('after-page')
      expect((await authorization.readAuthorization(f.args)).allowed).toBe(true)
      expect(saved(f.file).calls.some((args) => args.some((arg) => arg.includes('per_page=100&page=2')))).toBe(true)
    } finally {
      dispose(f.root)
    }
  })

  it('fails closed when a later authorization page cannot be read', async () => {
    const f = fixture()
    try {
      f.update((state) => {
        state.prs['10'].comments = Array.from({ length: 101 }, (_, index) => ({
          id: index + 1,
          author: 'operator',
          body: `ordinary ${index}`,
        }))
        state.nextCommentId = 101
      })
      await f.grant('before-page-failure')
      f.update((state) => {
        state.commentReadFailurePage = 2
      })
      await expect(authorization.readAuthorization(f.args)).rejects.toThrow()
    } finally {
      dispose(f.root)
    }
  })

  it('refuses a second admission from the same predecessor after another grant', async () => {
    const f = fixture()
    try {
      const snapshot = await authorization.captureAuthorization(f.args)
      await f.grant('winner')
      await expect(
        authorization.issueAuthorization({
          ...f.args,
          snapshot,
          lane: 'reviewed',
          source: 'native',
          evidence: 'review:other',
          operationId: 'loser',
        }),
      ).rejects.toThrow()
      expect(saved(f.file).prs['10'].comments.filter((comment) => comment.body.startsWith(PREFIX))).toHaveLength(1)
    } finally {
      dispose(f.root)
    }
  })

  it('does not push or claim disarm when withdrawal is forbidden even without a label', async () => {
    const f = fixture()
    try {
      await f.grant('before-forbidden')
      f.update((state) => {
        state.commentPostForbidden = true
      })
      let pushed = false
      await expect(
        disarmReviewedBeforePush(f.root, 10, {
          gh: f.gh,
          push: () => {
            pushed = true
          },
        }),
      ).rejects.toThrow()
      expect(pushed).toBe(false)
      expect((await authorization.readAuthorization(f.args)).allowed).toBe(true)
    } finally {
      dispose(f.root)
    }
  })

  it.each(['partial', 'forbidden'])('refuses a protected push when repository policy is %s', async (failure) => {
    const f = fixture()
    try {
      await f.grant('before-policy-failure')
      f.update((state) => {
        if (failure === 'partial') state.authorizationVariables = { HEAD_AUTH_REPOSITORY_ID: '1' }
        else state.authorizationVariablesForbidden = true
      })
      let pushed = false
      await expect(
        disarmReviewedBeforePush(f.root, 10, {
          gh: f.gh,
          push: () => {
            pushed = true
          },
        }),
      ).rejects.toThrow()
      expect(pushed).toBe(false)
    } finally {
      dispose(f.root)
    }
  })

  it('refuses review-start enforcement if withdrawal fails', async () => {
    const f = fixture()
    try {
      await f.grant('before-review')
      const gate = await readGate(f.root, 10, f.gh)
      f.update((state) => {
        state.commentPostForbidden = true
      })
      await expect(enforceArmedGate(f.root, 10, { gate, reviewing: true, gh: f.gh })).rejects.toThrow()
      expect((await authorization.readAuthorization(f.args)).allowed).toBe(true)
    } finally {
      dispose(f.root)
    }
  })
})
