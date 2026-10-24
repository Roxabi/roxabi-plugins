import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ACQUIRE, git, sandbox, worktree, writeSim } from './__fixtures__/proof/sandbox-repository'
import { SEMCTX_CONFIG } from './__fixtures__/proof/sandbox-semctx-base'
import { plainSpec } from './__fixtures__/proof/sandbox-semctx-spec'
import type { Box } from './__fixtures__/proof/sandbox-types'
import { approve } from './testing/proof-integration/data'
import { REAL_BUN } from './testing/proof-integration/environment'
import { land, UNARMED } from './testing/proof-integration/landing'
import { instrument, prepare, producerCalls } from './testing/proof-integration/setup'

describe('origin identity is bound to the selected repository before base policy', () => {
  let box: Box
  let wt: string
  let fork: string
  const pr = 30
  const head = () => box.sha['fix/5-plain'] as string
  beforeAll(() => {
    const spec = plainSpec()
    box = sandbox({
      ...spec,
      branches: [
        ...spec.branches,
        {
          name: 'canonical-configured',
          from: 'main',
          commits: [{ message: 'chore: canonical obligation', files: { '.semctx/config.json': SEMCTX_CONFIG } }],
        },
      ],
    })
    fork = path.join(box.root, 'fork.git')
    git(box, box.root, ['clone', '-q', '--bare', box.origin, fork])
    writeSim(box, (state) => {
      state.repositoryUrls = { [fork]: 'fork/app' }
    })
    instrument(box)
    wt = worktree(box, 'repository-bound', head())
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  function reset(armed = false): void {
    git(box, wt, ['remote', 'set-url', 'origin', box.origin])
    git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
    prepare(box, pr, { comments: [approve(head())], body: 'Closes #5\n', armed: armed ? head() : null })
  }

  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses fork absence instead of exempting the canonical base configuration',
    (mode) => {
      reset(true)
      git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha['canonical-configured'] as string])
      git(box, wt, ['remote', 'set-url', 'origin', fork])
      const refused = land(box, wt, pr, mode)
      expect(refused.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'candidate',
        reason: 'unbound',
        disarmed: true,
      })
      expect(refused.result.error).toContain('fork/app')
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.producers).toEqual([])

      reset()
      const admitted = land(box, wt, pr, mode)
      expect(admitted.result).toMatchObject({
        status: 'watching',
        proof: { semctx: 'absent', assertledger: 'not-applicable' },
      })
      expect(admitted.gate.labels).toEqual(['reviewed'])
      expect(admitted.producers).toEqual([])
    },
  )

  it('acquisition refuses the same mismatch; matching origin can report genuine absence', () => {
    reset()
    git(box, wt, ['remote', 'set-url', 'origin', fork])
    const refused = spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(pr)], { cwd: wt, env: box.env, encoding: 'utf8' })
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('candidate unbound')
    expect(refused.stderr).toContain('fork/app')
    expect(producerCalls(box)).toEqual([])

    reset()
    const admitted = spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(pr)], { cwd: wt, env: box.env, encoding: 'utf8' })
    expect(admitted.status).toBe(0)
    expect(JSON.parse(admitted.stdout)).toMatchObject({
      semctx: 'not-applicable',
      assertledger: 'not-applicable',
    })
    expect(producerCalls(box)).toEqual([])
  })

  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses landing as missing authority when a valid standalone approval has no workflow-binding',
    (mode) => {
      prepare(box, pr, {
        comments: [approve(head())],
        body: 'Closes #5\n',
        armed: head(),
        landingAuthority: false,
      })
      const refused = land(box, wt, pr, mode)
      expect(refused.result).toMatchObject({
        status: 'mandate-refused',
        reason: 'missing',
        disarmed: true,
      })
      expect(refused.result.status).not.toBe('proof-blocked')
      expect(refused.gate).toEqual(UNARMED)
      expect(refused.calls.some((args) => args.includes('--auto') || args.includes('--add-label'))).toBe(false)
      expect(refused.producers).toEqual([])
    },
  )
})
