import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LEDGER_BASE } from './__fixtures__/proof/sandbox-assertledger'
import { ACQUIRE, readSim, sandbox, worktree, writeSim } from './__fixtures__/proof/sandbox-repository'
import { STACK } from './__fixtures__/proof/sandbox-semctx-base'
import type { Box } from './__fixtures__/proof/sandbox-types'
import { linkedReviewInput } from './testing/proof-integration/authority'
import { approve, fixtureReviewBodies, proofFramePrefix } from './testing/proof-integration/data'
import { ME, REAL_BUN } from './testing/proof-integration/environment'
import { land, UNARMED } from './testing/proof-integration/landing'
import { instrument, isWorkflowBindingBody, prepare, producerCalls } from './testing/proof-integration/setup'
import { workflowRead } from './testing/proof-integration/workflow'

describe('Kit-only adapter presence does not make a shell/CP fix owe AssertLedger detection', () => {
  const PR = 809
  const CONFIGURED_PR = 810
  /** Separate Spec issue — do not self-Closes the PR number (legacy producer-admission arrangement). */
  const SPEC = 808
  const KIT_BODY = `Closes #${SPEC}\n`
  const KIT_ADAPTER = 'scripts/kit/assertledger/vitest-adapter.mjs'
  const CP_GATE = 'scripts/kit/check-cp.sh'
  const shellGate = (result: 'old' | 'fixed') =>
    `#!/bin/sh\nprintf '${result} CP gate\\n'\n${result === 'old' ? 'exit 1' : 'exit 0'}\n`
  let box: Box
  let kit: string
  let stale: string
  let configured: string
  const sha = (branch: string) => box.sha[branch] as string

  beforeAll(() => {
    box = sandbox({
      base: {
        '.dev/stack.yml': STACK,
        [KIT_ADAPTER]: "export const adapter = 'vitest'\n",
        [CP_GATE]: shellGate('old'),
      },
      branches: [
        {
          // Branch ticket must match Spec #808 so assertledgerApplies does not GraphQL a missing #809.
          name: 'fix/808-kit-shell',
          from: 'main',
          commits: [{ message: 'fix: harden CP shell gate (#808)', files: { [CP_GATE]: shellGate('fixed') } }],
        },
        {
          name: 'fix/808-kit-shell-stale-review',
          from: 'fix/808-kit-shell',
          commits: [
            { message: 'test: cover CP shell gate (#808)', files: { [CP_GATE]: `${shellGate('fixed')}# covered\n` } },
          ],
        },
        {
          name: 'fix/808-kit-configured',
          from: 'main',
          commits: [
            {
              message: 'fix: configure CP regression campaign (#808)',
              files: {
                [CP_GATE]: shellGate('fixed'),
                'assertledger.config.json': LEDGER_BASE['assertledger.config.json'] as string,
              },
            },
          ],
        },
      ],
      issues: [{ number: SPEC, title: 'fix: harden CP shell gate', issueType: 'fix' }],
      prs: [
        {
          number: PR,
          branch: 'fix/808-kit-shell',
          title: 'fix: harden CP shell gate',
          body: KIT_BODY,
          closes: [SPEC],
        },
        {
          number: CONFIGURED_PR,
          branch: 'fix/808-kit-configured',
          title: 'fix: configure CP regression campaign',
          body: KIT_BODY,
          closes: [SPEC],
        },
      ],
    })
    instrument(box)
    kit = worktree(box, 'kit-shell', sha('fix/808-kit-shell'))
    stale = worktree(box, 'kit-shell-stale', sha('fix/808-kit-shell-stale-review'))
    configured = worktree(box, 'kit-configured', sha('fix/808-kit-configured'))
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it.each(['native', 'merge-on-green'] as const)(
    '%s keeps its approval and configured CI gate while admitting the Kit-only shell/CP fix',
    (mode) => {
      const head = sha('fix/808-kit-shell')
      prepare(box, PR, { comments: [approve(head)], body: KIT_BODY })

      const run = land(box, kit, PR, mode)

      expect(run.result).toMatchObject({
        status: 'watching',
        mode,
        proof: { semctx: 'absent', assertledger: 'not-applicable' },
      })
      expect(run.gate).toEqual(
        mode === 'native'
          ? { labels: ['reviewed'], autoMerge: expect.objectContaining({ matchHeadCommit: head }) }
          : { labels: ['reviewed'], autoMerge: null },
      )
      expect(readSim(box).prs[String(PR)]?.state).toBe('OPEN')
      expect(run.producers).toEqual([])
    },
  )

  it('acquires no fake manifest or AssertLedger publication for the Kit-only shell/CP fix', () => {
    const head = sha('fix/808-kit-shell')
    prepare(box, PR, { comments: [approve(head)], body: KIT_BODY })

    const acquired = spawnSync(REAL_BUN, [ACQUIRE, '--pr', String(PR)], {
      cwd: kit,
      env: box.env,
      encoding: 'utf8',
    })

    expect(acquired.status).toBe(0)
    expect(JSON.parse(acquired.stdout)).toMatchObject({
      semctx: 'not-applicable',
      assertledger: 'not-applicable',
    })
    expect(
      readSim(box).prs[String(PR)]?.comments.some((comment) =>
        comment.body.startsWith(proofFramePrefix('assertledger')),
      ),
    ).toBe(false)
    expect(producerCalls(box)).toEqual([])
  })

  it('refuses a retained stale review binding, then admits a fresh no-producer Kit-only review', () => {
    const staleHead = sha('fix/808-kit-shell-stale-review')
    writeSim(box, (state) => {
      const pull = state.prs[String(PR)]
      if (!pull) throw new Error('missing Kit PR')
      pull.headRefName = 'fix/808-kit-shell-stale-review'
      pull.headRefOid = staleHead
      pull.baseRecord = { at: `main@${staleHead}`, oid: box.sha.main as string }
    })
    prepare(box, PR, { comments: [approve(staleHead)], body: KIT_BODY, armed: staleHead, binding: false })
    writeSim(box, (state) => {
      const pull = state.prs[String(PR)]
      if (!pull) throw new Error('missing stale Kit PR')
      const bindings = pull.comments.filter((comment) => isWorkflowBindingBody(comment.body))
      pull.comments = [
        ...bindings,
        ...fixtureReviewBodies(PR, approve(staleHead), '0'.repeat(64)).map((body) => ({ author: ME, body })),
      ]
    })

    const refused = land(box, stale, PR)

    expect(refused.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'candidate',
      reason: 'unbound',
      disarmed: true,
    })
    expect(refused.gate).toEqual(UNARMED)
    expect(refused.producers).toEqual([])

    prepare(box, PR, { comments: [approve(staleHead)], body: KIT_BODY })
    const captured = workflowRead(box, stale, PR, staleHead, 'captureReviewInput')
    const expected = linkedReviewInput(box, PR, staleHead, KIT_BODY, null)
    expect(captured.ok).toBe(true)
    expect(expected).not.toBeNull()
    expect(captured.input).toBe(expected)
    expect(captured.semctx).toBeNull()
    expect(captured.assertledger).toBeNull()

    const admitted = land(box, stale, PR)
    expect(admitted.result).toMatchObject({
      status: 'watching',
      proof: { semctx: 'absent', assertledger: 'not-applicable' },
    })
    expect(admitted.gate.labels).toEqual(['reviewed'])
    expect(admitted.producers).toEqual([])
  })

  it.each(['native', 'merge-on-green'] as const)(
    '%s refuses the missing detection when the Kit candidate explicitly declares a root configuration',
    (mode) => {
      const head = sha('fix/808-kit-configured')
      prepare(box, CONFIGURED_PR, { comments: [approve(head)], body: KIT_BODY, armed: head })

      const run = land(box, configured, CONFIGURED_PR, mode)

      expect(run.result).toMatchObject({
        status: 'proof-blocked',
        producer: 'assertledger',
        reason: 'missing',
        disarmed: true,
      })
      expect(run.gate).toEqual(UNARMED)
      expect(run.producers).toEqual([])
    },
  )
})
