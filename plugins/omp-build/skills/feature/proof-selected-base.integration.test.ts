import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { git, readSim, sandbox, worktree, writeSim } from './__fixtures__/proof/sandbox-repository'
import { SEMCTX_CONFIG } from './__fixtures__/proof/sandbox-semctx-base'
import { plainSpec } from './__fixtures__/proof/sandbox-semctx-spec'
import type { Box } from './__fixtures__/proof/sandbox-types'
import { linkedReviewInput, recordedBaseOf } from './testing/proof-integration/authority'
import { approve, fixtureReviewBodies, type LandRun } from './testing/proof-integration/data'
import { ME } from './testing/proof-integration/environment'
import { land, UNARMED } from './testing/proof-integration/landing'
import { mutateAfter } from './testing/proof-integration/mutation'
import { instrument, prepare } from './testing/proof-integration/setup'

describe('landPr retains the selected base name and tip', () => {
  let box: Box
  let wt: string
  const pr = 30
  const first = 'fix/5-plain'
  const next = 'fix/5-next'
  const head = () => box.sha[first] as string
  beforeAll(() => {
    const spec = plainSpec()
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        { name: next, from: first, commits: [{ message: 'fix: next (#5)', files: { 'NOTE.md': 'next\n' } }] },
        {
          name: 'staging',
          from: 'main',
          commits: [
            {
              message: 'chore: staging policy',
              files: {
                '.dev/stack.yml': 'landing:\n  mode: merge-on-green\n  required_checks:\n    - staging-ci\n',
                '.semctx/config.json': SEMCTX_CONFIG,
                'assertledger.config.json': '{}\n',
              },
            },
          ],
        },
      ],
    })
    instrument(box)
    wt = worktree(box, 'base-bound', head())
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  function reset(armed: boolean): void {
    git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
    git(box, wt, ['checkout', '-q', '--detach', head()])
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error('no plain PR')
      pull.baseRefName = 'main'
      pull.headRefName = first
    })
    prepare(box, pr, { comments: [approve(head())], body: 'Closes #5\n', armed: armed ? head() : null })
  }

  it.each([
    // admission-comments: mutateAfter rewrites after the triggering comments response.
    // Landing still decodes the pre-rewrite PR binding (matches snapshotted native.base)
    // while the next mandate history read sees the rewritten mandate.base → unknown-binding.
    ['native', 'admission-comments', false, 'mandate'],
    ['merge-on-green', 'admission-comments', false, 'mandate'],
    // Late arming writes keep a matched binding so bindBase observes the coordinate conflict.
    ['native', 'pin-write', false, 'bindBase'],
    ['native', 'disable-write', true, 'bindBase'],
    ['merge-on-green', 'remove-label-write', true, 'bindBase'],
    ['native', 'label-write', false, 'bindBase'],
    ['merge-on-green', 'label-write', false, 'bindBase'],
  ] as const)('%s refuses a base retarget after %s (previous arm: %s)', (mode, when, armed, layer) => {
    reset(armed)
    const restore = mutateAfter(box, when, `retargetPullBase(${pr}, 'staging')`)
    try {
      const { result, gate, calls, producers } = land(box, wt, pr, mode)
      if (layer === 'bindBase') {
        expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unbound' })
        expect(result.error).toContain(`staging@${box.sha.staging}`)
        expect(result.error).toContain(`main@${box.sha.main}`)
      } else {
        expect(result).toMatchObject({ status: 'mandate-refused', reason: 'unknown-binding' })
      }
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
      if (when === 'admission-comments' || when === 'disable-write' || when === 'remove-label-write') {
        expect(calls.some((args) => args.includes('--add-label'))).toBe(false)
        if (!armed) expect(calls.some((args) => args.includes('--auto'))).toBe(false)
      }
    } finally {
      restore()
    }
  })

  it.each([
    ['native', 'disable-write'],
    ['merge-on-green', 'remove-label-write'],
  ] as const)('%s cannot re-admit a freshly approved H2 against the old base after %s', (mode, when) => {
    reset(true)
    const h2 = box.sha[next] as string
    const h2Input = linkedReviewInput(box, pr, h2, 'Closes #5\n', null)
    const restore = mutateAfter(
      box,
      when,
      `
      retargetPullBase(${pr}, 'staging');
      state.prs[${pr}].headRefName = ${JSON.stringify(next)};
      state.prs[${pr}].comments.push(...${JSON.stringify(fixtureReviewBodies(pr, approve(h2), h2Input).map((body) => ({ author: ME, body })))});
      const checkout = spawnSync('git', ['-C', ${JSON.stringify(wt)}, 'checkout', '-q', '--detach', ${JSON.stringify(h2)}], { env: process.env, encoding: 'utf8' });
      if (checkout.status !== 0) throw new Error(checkout.stderr);
    `,
    )
    try {
      const { result, gate, producers } = land(box, wt, pr, mode)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unbound' })
      expect(result.error).toContain(`staging@${box.sha.staging}`)
      expect(result.error).toContain(`main@${box.sha.main}`)
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
      expect(git(box, wt, ['rev-parse', 'HEAD'])).toBe(h2)
    } finally {
      restore()
    }
  })

  it.each([
    ['native', 'pin-write', false],
    ['native', 'pin-write', true],
    ['native', 'label-write', false],
    ['merge-on-green', 'label-write', false],
  ] as const)(
    '%s refuses a freshly approved H2 that replaces the armed H after %s (previous arm: %s)',
    (mode, when, armed) => {
      reset(armed)
      const h2 = box.sha[next] as string
      const h2Input = linkedReviewInput(box, pr, h2, 'Closes #5\n', null)
      const restore = mutateAfter(
        box,
        when,
        `
      state.prs[${pr}].headRefName = ${JSON.stringify(next)};
      state.prs[${pr}].comments.push(...${JSON.stringify(fixtureReviewBodies(pr, approve(h2), h2Input).map((body) => ({ author: ME, body })))});
      const checkout = spawnSync('git', ['-C', ${JSON.stringify(wt)}, 'checkout', '-q', '--detach', ${JSON.stringify(h2)}], { env: process.env, encoding: 'utf8' });
      if (checkout.status !== 0) throw new Error(checkout.stderr);
    `,
      )
      try {
        const { result, calls, gate, producers } = land(box, wt, pr, mode)
        expect(result).toMatchObject({ status: 'not-approved', reason: 'head-moved' })
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
        const pins = calls.filter((args) => args.includes('--match-head-commit')).map((args) => args.at(-1))
        expect(pins).toEqual(mode === 'native' ? [head()] : [])
        const disabledAt = calls.findIndex((args) => args.includes('--disable-auto'))
        const pinnedAt = calls.findIndex((args) => args.includes('--match-head-commit'))
        expect(disabledAt !== -1 && disabledAt < pinnedAt).toBe(mode === 'native' && armed)
        if (when === 'pin-write') expect(calls.some((args) => args.includes('--add-label'))).toBe(false)
      } finally {
        restore()
      }
    },
  )

  it.each(['native', 'merge-on-green'] as const)('%s keeps watching the armed H when nothing moves', (mode) => {
    reset(false)
    const { result, gate, producers } = land(box, wt, pr, mode)
    expect(result).toMatchObject({ status: 'watching', mode })
    expect(gate).toEqual(
      mode === 'native'
        ? { labels: ['reviewed'], autoMerge: expect.objectContaining({ matchHeadCommit: head() }) }
        : { labels: ['reviewed'], autoMerge: null },
    )
    expect(producers).toEqual([])
  })

  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses a base that moves after selection while baseRefOid still reports the selected tip',
    (mode) => {
      reset(false)
      const restore = mutateAfter(
        box,
        'label-write',
        `
      const moved = spawnSync('git', ['--git-dir', ${JSON.stringify(box.origin)}, 'update-ref', 'refs/heads/main', ${JSON.stringify(box.sha.staging)}], { env: process.env, encoding: 'utf8' });
      if (moved.status !== 0) throw new Error(moved.stderr);
    `,
      )
      try {
        const { result, gate, producers } = land(box, wt, pr, mode)
        expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unbound' })
        expect(result.error).toContain(`main@${box.sha.staging}`)
        expect(result.error).toContain(`main@${box.sha.main}`)
        expect(gate).toEqual(UNARMED)
        expect(producers).toEqual([])
        expect(recordedBaseOf(box, pr)).toBe(box.sha.main)
      } finally {
        restore()
        git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
      }
    },
  )

  describe('a clean PR merges as soon as it is armed, moving the base itself', () => {
    function armGreen(): void {
      writeSim(box, (state) => {
        state.checks[head()] = [
          {
            name: 'ci',
            status: 'completed',
            conclusion: 'success',
            workflowName: 'ci',
            startedAt: '2026-01-01T00:00:00Z',
          },
        ]
      })
    }
    function reopen(): void {
      writeSim(box, (state) => {
        const pull = state.prs[String(pr)]
        if (!pull) throw new Error('no plain PR')
        pull.state = 'OPEN'
        pull.mergeCommit = null
        pull.mergedAt = null
        delete state.checks[head()]
        for (const number of pull.closes) {
          const issue = state.issues[String(number)]
          if (issue) issue.state = 'OPEN'
        }
      })
      git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
    }

    it.each(['native', 'merge-on-green'] as const)('%s lands it onto the selected tip', (mode) => {
      reset(false)
      armGreen()
      try {
        const { result, producers } = land(box, wt, pr, mode)
        expect(result).toMatchObject({ status: mode === 'native' ? 'merged' : 'watching' })
        const merged = readSim(box).prs[String(pr)]
        expect(merged?.state).toBe('MERGED')
        expect(merged?.mergeCommit?.parents).toEqual([box.sha.main, head()])
        expect(producers).toEqual([])
      } finally {
        reopen()
      }
    })

    it('returns merged without arming the label when native auto-merge completes during its post-write observation', () => {
      reset(false)
      armGreen()
      try {
        const run = land(box, wt, pr, 'native')

        expect(run.result).toEqual({ status: 'merged' })
        expect(readSim(box).prs[String(pr)]?.state).toBe('MERGED')
        expect(run.gate).toEqual(UNARMED)
        expect(
          run.calls.filter(
            (args) =>
              args[0] === 'pr' && args[1] === 'edit' && args.includes('--add-label') && args.includes('reviewed'),
          ),
        ).toHaveLength(0)
        expect(
          run.calls.filter(
            (args) =>
              args[0] === 'pr' &&
              args[1] === 'merge' &&
              args.includes('--auto') &&
              args.includes('--match-head-commit'),
          ),
        ).toHaveLength(1)
      } finally {
        reopen()
      }
    })

    it('native refuses it once it merged onto a base that moved after selection', () => {
      reset(false)
      armGreen()
      const restore = mutateAfter(
        box,
        'pin-write',
        `
      const moved = spawnSync('git', ['--git-dir', ${JSON.stringify(box.origin)}, 'update-ref', 'refs/heads/main', ${JSON.stringify(box.sha.staging)}], { env: process.env, encoding: 'utf8' });
      if (moved.status !== 0) throw new Error(moved.stderr);
    `,
      )
      try {
        const { result, producers } = land(box, wt, pr, 'native')
        expect(result).toMatchObject({ status: 'auto-merge-failed' })
        expect(result.error).toMatch(/merged while being disarmed/)
        expect(readSim(box).prs[String(pr)]?.mergeCommit?.parents).toEqual([box.sha.staging, head()])
        expect(producers).toEqual([])
      } finally {
        restore()
        reopen()
      }
    })

    it('merge-on-green keeps a same-base wrong-head merge as a refusal, never watching', () => {
      reset(false)
      armGreen()
      const h2 = box.sha[next] as string
      const restore = mutateAfter(
        box,
        'label-write',
        `
      state.prs[${pr}].headRefOid = ${JSON.stringify(h2)};
      state.prs[${pr}].headRefName = ${JSON.stringify(next)};
      state.checks[${JSON.stringify(h2)}] = [{
        name: 'ci',
        status: 'completed',
        conclusion: 'success',
        workflowName: 'ci',
        startedAt: '2026-01-01T00:00:00Z',
      }];
    `,
      )
      try {
        const run = land(box, wt, pr, 'merge-on-green')
        expect(run.result.status).not.toBe('watching')
        expect(run.result.status).not.toBe('merged')
        expect(
          run.result.status === 'not-approved' ||
            run.result.status === 'auto-merge-failed' ||
            run.result.status === 'proof-blocked',
        ).toBe(true)
        if (run.result.status === 'not-approved') {
          expect(run.result).toMatchObject({ reason: 'head-moved' })
        }
        const merged = readSim(box).prs[String(pr)]
        if (merged?.state === 'MERGED') {
          expect(merged.mergeCommit?.parents).toEqual([box.sha.main, h2])
        }
        expect(run.producers).toEqual([])
      } finally {
        restore()
        reopen()
      }
    })

    it('native does not claim merged or watching when a tip-matched merge races a post-admit refusal', () => {
      reset(false)
      armGreen()
      const h2 = box.sha[next] as string
      const restore = mutateAfter(
        box,
        'pin-write',
        `
      state.prs[${pr}].headRefOid = ${JSON.stringify(h2)};
      state.prs[${pr}].headRefName = ${JSON.stringify(next)};
      if (state.prs[${pr}].autoMerge) state.prs[${pr}].autoMerge.matchHeadCommit = ${JSON.stringify(h2)};
      state.checks[${JSON.stringify(h2)}] = [{
        name: 'ci',
        status: 'completed',
        conclusion: 'success',
        workflowName: 'ci',
        startedAt: '2026-01-01T00:00:00Z',
      }];
    `,
      )
      try {
        const run = land(box, wt, pr, 'native')
        expect(run.result.status).not.toBe('watching')
        expect(run.result.status).not.toBe('merged')
        expect(
          run.result.status === 'not-approved' ||
            run.result.status === 'auto-merge-failed' ||
            run.result.status === 'proof-blocked',
        ).toBe(true)
        if (run.result.status === 'not-approved') {
          expect(run.result).toMatchObject({ reason: 'head-moved' })
        }
        const merged = readSim(box).prs[String(pr)]
        if (merged?.state === 'MERGED') {
          expect(merged.mergeCommit?.parents?.[1]).toBe(h2)
          expect(merged.mergeCommit?.parents?.[1]).not.toBe(head())
        }
        expect(run.producers).toEqual([])
      } finally {
        restore()
        reopen()
      }
    })

    it('does not claim merged or watching when admission never succeeds and a prior arm settles onto the tip', () => {
      reset(true)
      armGreen()
      const restore = mutateAfter(box, 'admission-comments', `retargetPullBase(${pr}, 'staging')`)
      try {
        let run: LandRun | undefined
        let thrown: unknown
        try {
          run = land(box, wt, pr, 'native')
        } catch (error) {
          thrown = error
        }
        if (run !== undefined) {
          expect(run.result.status).not.toBe('watching')
          expect(run.result.status).not.toBe('merged')
          expect(
            run.result.status === 'not-approved' ||
              run.result.status === 'auto-merge-failed' ||
              run.result.status === 'proof-blocked' ||
              run.result.status === 'mandate-refused',
          ).toBe(true)
          expect(run.producers).toEqual([])
        } else {
          expect(String(thrown)).toMatch(/merged while being disarmed|landPr exited/)
          expect(String(thrown)).not.toMatch(/"status":"watching"|"status":"merged"/)
        }
      } finally {
        restore()
        reopen()
      }
    })
  })

  it.each(['native', 'merge-on-green'] as const)('%s refuses a selected base with no readable tip', (mode) => {
    reset(false)
    const restore = mutateAfter(box, 'label-write', `retargetPullBase(${pr}, 'missing')`)
    try {
      const { result, gate, producers } = land(box, wt, pr, mode)
      expect(result).toMatchObject({ status: 'proof-blocked', producer: 'candidate', reason: 'unreadable' })
      expect(result.error).toMatch(/base.*(missing|readable|coordinate|tip)/)
      expect(gate).toEqual(UNARMED)
      expect(producers).toEqual([])
    } finally {
      restore()
    }
  })
})
