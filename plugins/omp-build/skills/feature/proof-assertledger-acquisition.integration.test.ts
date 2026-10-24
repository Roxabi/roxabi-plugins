import { spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LEDGER_CASES, ledgerSpec } from './__fixtures__/proof/sandbox-assertledger'
import { ACQUIRE, git, sandbox, worktree, writeSim } from './__fixtures__/proof/sandbox-repository'
import type { Box } from './__fixtures__/proof/sandbox-types'
import type { AssertledgerRecord } from './proof-assertledger'
import { recordedBaseOf } from './testing/proof-integration/authority'
import {
  approve,
  conserved,
  decodeFixtureProof,
  fixtureReviewBodies,
  RECORDS,
  type ReplayCapture,
} from './testing/proof-integration/data'
import { ME, REAL_BUN } from './testing/proof-integration/environment'
import { land, UNARMED } from './testing/proof-integration/landing'
import { mutateAfter } from './testing/proof-integration/mutation'
import { bindFixtureReview, instrument, prepare, producerCalls } from './testing/proof-integration/setup'

describe('assertledger acquisition binds the exact replayed manifest bytes', () => {
  let box: Box
  let wt: string
  const { pr, branch } = LEDGER_CASES.detection
  let valid: string
  let invalid: string
  let exporter: string
  let replay: ReplayCapture
  beforeAll(() => {
    box = sandbox(ledgerSpec())
    instrument(box)
    wt = worktree(box, 'immutable-manifest', box.sha[branch] as string)
    const found = decodeFixtureProof(
      conserved(RECORDS.assertledger, 'detection').map((body) => ({ author: { login: ME }, body })),
      'assertledger',
      box.sha[branch] as string,
      pr,
    )
    if (!RECORDS.assertledger.replays) throw new Error('native replay counterparts are missing; regenerate capture.ts')
    valid = (found.record as AssertledgerRecord).native.manifest
    replay = RECORDS.assertledger.replays
    invalid = valid.replace(replay.token.from, replay.token.to)
    if (invalid === valid) throw new Error('the native replay counterpart does not match this manifest')
    exporter = path.join(box.root, 'exporter.json')
  })
  afterAll(() => rmSync(box.root, { recursive: true, force: true }))
  function acquire(manifest = true) {
    return spawnSync(
      REAL_BUN,
      [ACQUIRE, '--pr', String(pr), ...(manifest ? ['--assertledger-manifest', exporter] : [])],
      { cwd: wt, env: box.env, encoding: 'utf8' },
    )
  }
  function mutateExporterAtVersion(to: string): void {
    writeFileSync(
      path.join(box.root, 'producers', 'assertledger'),
      `#!${REAL_BUN}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(path.join(box.root, 'producer-calls.log'))}, 'assertledger ' + args.join(' ') + '\\n')
if (args[0] === '--version') {
  writeFileSync(${JSON.stringify(exporter)}, ${JSON.stringify(to)})
  process.stdout.write(${JSON.stringify(replay.version.stdout)})
  process.exit(${JSON.stringify(replay.version.code)})
}
if (args[0] !== 'replay' || args[2] !== '--json') throw new Error('unexpected native replay invocation')
const bytes = readFileSync(args[1], 'utf8')
const result = bytes === ${JSON.stringify(valid)} ? ${JSON.stringify(replay.valid)}
  : bytes === ${JSON.stringify(invalid)} ? ${JSON.stringify(replay.invalid)} : null
if (!result) throw new Error('no genuinely observed native replay for these bytes')
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exit(result.code)
`,
    )
  }
  it('an invalid captured manifest cannot borrow a valid replay from its overwritten exporter', () => {
    const head = box.sha[branch] as string
    prepare(box, pr, { comments: [approve(head)], body: 'Closes #2\n', armed: head })
    writeFileSync(exporter, invalid)
    mutateExporterAtVersion(valid)
    const acquired = acquire()
    expect(acquired.status).toBe(1)
    const before = producerCalls(box)
    const run = land(box, wt, pr)
    expect(run.result).toMatchObject({
      status: 'proof-blocked',
      producer: 'assertledger',
      reason: 'missing',
      disarmed: true,
    })
    expect(run.gate).toEqual(UNARMED)
    expect(run.producers).toEqual(before)
  })
  it('a valid captured manifest remains a detection when the exporter changes, and is reused without replay', () => {
    const head = box.sha[branch] as string
    prepare(box, pr, { comments: [approve(head)], body: 'Closes #2\n' })
    writeFileSync(exporter, valid)
    mutateExporterAtVersion(invalid)
    const acquired = acquire()
    expect(acquired.status).toBe(0)
    expect(JSON.parse(acquired.stdout)).toMatchObject({ assertledger: 'posted' })
    const before = producerCalls(box)
    const resumed = acquire(false)
    expect(resumed.status).toBe(0)
    expect(JSON.parse(resumed.stdout)).toMatchObject({ assertledger: 'reused' })
    writeSim(box, (state) => {
      const pull = state.prs[String(pr)]
      if (!pull) throw new Error('missing PR')
      pull.comments.push(...fixtureReviewBodies(pr, approve(head)).map((body) => ({ author: ME, body })))
    })
    bindFixtureReview(box, pr, [approve(head)])
    const run = land(box, wt, pr)
    expect(run.result).toMatchObject({ status: 'watching', proof: { assertledger: 'detection' } })
    expect(run.gate).toEqual({ labels: ['reviewed'], autoMerge: expect.objectContaining({ matchHeadCommit: head }) })
    expect(run.producers).toEqual(before)
  })
  it('stops publishing once the base moves, though baseRefOid still reports the selected tip', () => {
    const head = box.sha[branch] as string
    const moved = box.sha[LEDGER_CASES.weak.branch] as string
    prepare(box, pr, { comments: [approve(head)], body: 'Closes #2\n' })
    writeFileSync(exporter, valid)
    mutateExporterAtVersion(valid)
    const restore = mutateAfter(
      box,
      'comment-write',
      `spawnSync('git', ['--git-dir', state.origin, 'update-ref', 'refs/heads/main', ${JSON.stringify(moved)}], { env: process.env });`,
    )
    try {
      const acquired = acquire()
      expect(acquired.status).toBe(1)
      expect(acquired.stderr).toContain('coordinates changed')
      expect(acquired.stderr).toContain(`main@${box.sha.main} → ${moved}`)
      expect(recordedBaseOf(box, pr)).toBe(box.sha.main)
    } finally {
      restore()
      git(box, box.origin, ['update-ref', 'refs/heads/main', box.sha.main as string])
    }
  })
})
