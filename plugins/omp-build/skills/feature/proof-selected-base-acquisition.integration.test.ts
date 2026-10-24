import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LEDGER_BASE } from './__fixtures__/proof/sandbox-assertledger'
import { ACQUIRE, git, sandbox, worktree, writeSim } from './__fixtures__/proof/sandbox-repository'
import { SEMCTX_CONFIG } from './__fixtures__/proof/sandbox-semctx-base'
import { plainSpec } from './__fixtures__/proof/sandbox-semctx-spec'
import type { Box } from './__fixtures__/proof/sandbox-types'
import { recordedBaseOf } from './testing/proof-integration/authority'
import { approve } from './testing/proof-integration/data'
import { REAL_BUN } from './testing/proof-integration/environment'
import { land, UNARMED } from './testing/proof-integration/landing'
import { mutateAfter } from './testing/proof-integration/mutation'
import { instrument, prepare, producerCalls } from './testing/proof-integration/setup'

describe('selected base acquisition precedes policy and applicability', () => {
  let box: Box
  let wt: string
  const pr = 30
  const branch = 'fix/5-plain'
  const head = () => box.sha[branch] as string
  beforeAll(() => {
    const spec = plainSpec()
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        ...Object.entries<Record<string, string>>({
          configured: { '.semctx/config.json': SEMCTX_CONFIG },
          adapter: { 'assertledger.config.json': LEDGER_BASE['assertledger.config.json'] as string },
          policy: { '.dev/stack.yml': 'landing:\n  mode: merge-on-green\n' },
          malformed: { '.dev/stack.yml': 'landing: [\n' },
          moved: { 'docs/BASE.md': 'the base moved on\n' },
        }).map(([name, files]) => ({
          name,
          from: 'main',
          commits: [{ message: `chore: ${name}`, files }],
        })),
      ],
    })
    instrument(box)
    wt = worktree(box, 'fresh-base', head())
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))
  function reset(next = 'main', armed = true): void {
    git(box, wt, ['remote', 'set-url', 'origin', box.origin])
    git(box, wt, ['update-ref', 'refs/remotes/origin/main', box.sha.main as string])
    const tip = box.sha[next] as string
    git(box, box.origin, ['update-ref', 'refs/heads/main', tip])
    // Seed pins at the intended origin tip after it is established; do not leave mandate at stale main.
    prepare(box, pr, {
      comments: [approve(head())],
      body: 'Closes #5\n',
      armed: armed ? head() : null,
      baseTip: tip,
    })
  }
  function acquire() {
    return spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(pr)], { cwd: wt, env: box.env, encoding: 'utf8' })
  }
  it.each([
    ['native', 'configured', 'semctx', 'ambiguous'],
    ['merge-on-green', 'configured', 'semctx', 'ambiguous'],
    ['native', 'adapter', 'assertledger', 'missing'],
    ['merge-on-green', 'adapter', 'assertledger', 'missing'],
  ] as const)(
    '%s refuses the newly committed %s obligation despite an absent cached base',
    (mode, next, producer, reason) => {
      reset(next)
      const run = land(box, wt, pr, mode)
      expect(run.result).toMatchObject({ status: 'proof-blocked', producer, reason, disarmed: true })
      expect(run.gate).toEqual(UNARMED)
      expect(run.producers).toEqual([])
    },
  )
  it.each(['configured', 'adapter'])(
    'acquisition does not report absence when the authoritative base adds %s',
    (next) => {
      reset(next)
      const run = acquire()
      expect(run.status).toBe(1)
      expect(run.stderr).toContain(next === 'configured' ? 'semctx ambiguous' : 'manifest')
      expect(producerCalls(box)).toEqual([])
    },
  )
  it('reads the new base policy, not the cached native policy or the candidate policy', () => {
    reset('policy', false)
    const run = land(box, wt, pr)
    expect(run.result).toMatchObject({ status: 'watching', mode: 'merge-on-green' })
    expect(run.gate).toEqual({ labels: ['reviewed'], autoMerge: null })
    expect(run.producers).toEqual([])
  })
  it('a newly malformed base policy clears the existing arm', () => {
    reset('malformed')
    const run = land(box, wt, pr)
    expect(run.result).toMatchObject({ status: 'bad-landing', disarmed: true })
    expect(run.gate).toEqual(UNARMED)
  })
  it.each(['native', 'merge-on-green'] as const)(
    '%s lands against the fetched base tip that GitHub’s recorded baseRefOid predates',
    (mode) => {
      reset('moved', false)
      expect(recordedBaseOf(box, pr)).toBe(box.sha.main)
      const run = land(box, wt, pr, mode)
      expect(run.result).toMatchObject({ status: 'watching', mode })
      expect(run.gate.labels).toEqual(['reviewed'])
      expect(run.producers).toEqual([])
    },
  )
  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses failed base acquisition instead of trusting the cached absence',
    (mode) => {
      reset()
      git(box, wt, ['remote', 'set-url', 'origin', path.join(box.root, 'missing-origin')])
      writeSim(box, (state) => {
        state.repositoryUrls = { [path.join(box.root, 'missing-origin')]: 'acme/app' }
      })
      const run = land(box, wt, pr, mode)
      expect(run.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'candidate',
        reason: 'unreadable',
        disarmed: true,
      })
      expect(run.result.error).toContain('fetch')
      expect(run.gate).toEqual(UNARMED)
      expect(run.producers).toEqual([])
    },
  )
  it('acquisition fails on fetch failure even when both cached obligations are absent', () => {
    reset()
    git(box, wt, ['remote', 'set-url', 'origin', path.join(box.root, 'missing-origin')])
    writeSim(box, (state) => {
      state.repositoryUrls = { [path.join(box.root, 'missing-origin')]: 'acme/app' }
    })
    const run = acquire()
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('fetch')
    expect(producerCalls(box)).toEqual([])
  })
  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses a base that moves between selection and admission while baseRefOid still reports the selected tip',
    (mode) => {
      reset()
      const restore = mutateAfter(
        box,
        'admission-base-read',
        `spawnSync('git', ['--git-dir', state.origin, 'update-ref', 'refs/heads/main', ${JSON.stringify(box.sha.configured)}], { env: process.env });`,
      )
      try {
        const run = land(box, wt, pr, mode)
        expect(run.result).toMatchObject({
          status: 'proof-blocked',
          producer: 'candidate',
          reason: 'unbound',
          disarmed: true,
        })
        expect(run.result.error).toContain(box.sha.configured)
        expect(run.result.error).toContain(box.sha.main)
        expect(run.gate).toEqual(UNARMED)
        expect(run.producers).toEqual([])
        expect(recordedBaseOf(box, pr)).toBe(box.sha.main)
      } finally {
        restore()
      }
    },
  )
  it.each([
    ['configured', 'semctx', 'ambiguous'],
    ['adapter', 'assertledger', 'missing'],
  ] as const)(
    'reads the established %s base object even if the tracking ref is rewritten between selection and admission',
    (next, producer, reason) => {
      reset(next)
      const restore = mutateAfter(
        box,
        'admission-base-read',
        `spawnSync('git', ['-C', ${JSON.stringify(wt)}, 'update-ref', 'refs/remotes/origin/main', ${JSON.stringify(box.sha.main)}], { env: process.env });`,
      )
      try {
        const run = land(box, wt, pr)
        expect(run.result).toMatchObject({ status: 'proof-blocked', producer, reason, disarmed: true })
        expect(run.gate).toEqual(UNARMED)
        expect(run.producers).toEqual([])
      } finally {
        restore()
      }
    },
  )
  it('acquisition refuses base drift after reading applicability and before reporting reuse or absence', () => {
    reset()
    const restore = mutateAfter(
      box,
      'acquisition-comments',
      `spawnSync('git', ['--git-dir', state.origin, 'update-ref', 'refs/heads/main', ${JSON.stringify(box.sha.configured)}], { env: process.env });`,
    )
    try {
      const run = acquire()
      expect(run.status).toBe(1)
      expect(run.stderr).toContain('coordinates changed')
      expect(producerCalls(box)).toEqual([])
    } finally {
      restore()
    }
  })
})
