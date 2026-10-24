import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BOTH_CASE, bothSpec } from './__fixtures__/proof/sandbox-both'
import { sandbox, worktree, writeSim } from './__fixtures__/proof/sandbox-repository'
import type { Box } from './__fixtures__/proof/sandbox-types'
import { approve, conserved, proofOperationMarker, RECORDS } from './testing/proof-integration/data'
import { land, UNARMED } from './testing/proof-integration/landing'
import { instrument, prepare, rewriteProducerProofs } from './testing/proof-integration/setup'

describe('landPr admission where Semctx and an assertledger adapter both apply', () => {
  const { pr, branch } = BOTH_CASE
  const posted = conserved(RECORDS.both, 'both')
  let box: Box
  let dir: string

  beforeAll(() => {
    box = sandbox(bothSpec())
    for (const [name, value] of Object.entries(RECORDS.both.sha)) {
      if (box.sha[name] !== value)
        throw new Error(`${name} rebuilt as ${box.sha[name]}, recorded ${value}: re-run capture.ts`)
    }
    instrument(box)
    dir = worktree(box, 'both', box.sha[branch] as string)
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))

  it('an admitted Semctx record does not waive the detection; both records admit', () => {
    const candidate = box.sha[branch] as string
    const semctx = posted.filter((body) => body.includes(proofOperationMarker('semctx', candidate)))
    // Seed both producers (actual capture), then drop assertledger before the refused land.
    prepare(box, pr, { comments: [approve(candidate), ...posted], body: 'Closes #2\n' })
    rewriteProducerProofs(box, pr, semctx)
    const refused = land(box, dir, pr)
    expect(refused.result).toMatchObject({ status: 'proof-blocked', producer: 'assertledger', reason: 'missing' })
    expect(refused.gate).toEqual(UNARMED)

    prepare(box, pr, { comments: [approve(candidate), ...posted], body: 'Closes #2\n' })
    const admitted = land(box, dir, pr)
    expect(admitted.result).toMatchObject({
      status: 'watching',
      proof: { semctx: { verdict: 'VERIFIED' }, assertledger: 'detection' },
    })
    expect(admitted.gate.labels).toEqual(['reviewed'])
    expect([...refused.producers, ...admitted.producers]).toEqual([])
  })
  it('exact review inputs include the assertledger publication, not only Semctx or PARTIAL', () => {
    const candidate = box.sha[branch]
    if (!candidate) throw new Error('missing dual-producer head')
    prepare(box, pr, { comments: [approve(candidate), ...posted], body: 'Closes #2\n', armed: candidate })
    writeSim(box, (state) => {
      const part = state.prs[String(pr)]?.comments.find((comment) =>
        comment.body.includes(proofOperationMarker('assertledger', candidate)),
      )
      if (!part) throw new Error('missing native assertledger publication')
      part.body = `${part.body}\nfixture transport mutation`
    })
    const refused = land(box, dir, pr)
    expect(refused.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'candidate',
      reason: 'unbound',
      disarmed: true,
    })
    expect(refused.gate).toEqual(UNARMED)
    expect(refused.producers).toEqual([])
    prepare(box, pr, { comments: [approve(candidate), ...posted], body: 'Closes #2\n' })
    const admitted = land(box, dir, pr)
    expect(admitted.result).toMatchObject({
      status: 'watching',
      proof: { semctx: { verdict: 'VERIFIED' }, assertledger: 'detection' },
    })
    expect(admitted.producers).toEqual([])
  })
})
