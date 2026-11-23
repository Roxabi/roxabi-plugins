import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { pullHistory } from '../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../testing/feature-review-fixture.ts'
import { seedFixRecoveryPrefix } from '../testing/fix-recovery-prefix-fixture.ts'
import { readSim, writeSim } from '../testing/sandbox/sandbox-repository.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('reads a historical close of a torn request and retains late raw parts without reactivating it', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  const runner = path.resolve(import.meta.dirname, '../testing/fix-recovery-prefix-reader.ts')
  const read = () => {
    const run = spawnSync(bun, [runner, cwd], {
      cwd,
      env: box.env,
      encoding: 'utf8',
      timeout: 55_000,
    })
    expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0)
    const result = JSON.parse(run.stdout)
    expect(result.error, JSON.stringify(result)).toBeUndefined()
    return result
  }
  // Owner, witness and confirmation are historical fixture data, not native host proof.
  // The real encoder uses a test-only 400-byte limit for R, not native production's 65536-byte limit.
  const fixture = await seedFixRecoveryPrefix(box, cwd, 'torn-request')
  const baseline = fixture.baseline
  expect(baseline).toMatchObject({ accepted: 'accepted', observation: 'complete' })
  expect(fixture.framedRequest[0]).toMatch(/kind=fix-request .*part=1\/(?:[2-9]|[1-9][0-9]+)/)
  const raw = pullHistory(box)
  expect(raw.operations.find((item) => item.operationId === fixture.source.operationId)).toMatchObject({
    status: 'complete',
    record: { kind: 'contribution' },
  })
  expect(raw.operations.find((item) => item.operationId === fixture.request.operationId)).toMatchObject({
    status: 'incomplete',
    record: null,
  })
  const torn = read()
  expect(torn).toMatchObject({
    accepted: 'refused',
    observation: 'incomplete',
    admission: { framed: false, deliverable: false },
    fixRecovery: { status: 'interrupted', owner: fixture.opened, settled: fixture.settled, phase: fixture.interrupted },
  })
  expect(torn.observationDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'incomplete', message: expect.stringContaining(fixture.request.operationId) }),
    ]),
  )
  const controlBodies = await fixture.frameClose()
  const post = (body: string) =>
    execFileSync('gh', ['api', '--method', 'POST', 'repos/acme/app/issues/7/comments', '-f', `body=${body}`], {
      cwd,
      env: box.env,
      encoding: 'utf8',
    })
  for (const body of controlBodies) post(body)
  const closed = read()
  expect(closed, JSON.stringify(closed)).toMatchObject({
    accepted: 'accepted',
    observation: 'complete',
    admission: baseline.admission,
  })
  const prior = readSim(box)
  const issueBefore = prior.issues['42']?.comments.map((item) => item.body) ?? []
  const prBefore = prior.prs['7']?.comments.map((item) => item.body) ?? []
  expect(prBefore).toEqual(
    expect.arrayContaining([...fixture.framedSource, fixture.framedRequest[0], ...controlBodies]),
  )
  for (const body of fixture.framedRequest.slice(1)) post(body)
  const complete = pullHistory(box)
  expect(complete.operations.find((item) => item.operationId === fixture.request.operationId)).toMatchObject({
    status: 'complete',
    record: { kind: 'fix-request', recordId: fixture.request.recordId },
  })
  expect(complete.operations.some((item) => item.record?.kind === 'decision')).toBe(false)
  const late = read()
  expect(late, JSON.stringify(late)).toMatchObject({
    accepted: 'accepted',
    observation: 'complete',
    admission: baseline.admission,
  })
  const prEffective = late.recoveryEvidence.find(
    (item: { scope: { target: string } }) => item.scope.target === fixture.pullRequest.target,
  )
  expect(prEffective).toBeDefined()
  expect(
    prEffective.operations.some((item: { operationId: string }) => item.operationId === fixture.request.operationId),
  ).toBe(false)
  expect(
    prEffective.operations.some((item: { operationId: string }) => item.operationId === fixture.source.operationId),
  ).toBe(true)
  const now = readSim(box)
  expect(now.issues['42']?.comments.map((item) => item.body)).toEqual(expect.arrayContaining(issueBefore))
  expect(now.prs['7']?.comments.map((item) => item.body)).toEqual(
    expect.arrayContaining([...prBefore, ...fixture.framedRequest]),
  )

  const firstPart = fixture.framedRequest[0]
  if (firstPart === undefined) throw new Error('fixture-request-part-missing')
  const unrelated = firstPart
    .replace(`id=${fixture.request.recordId} `, 'id=unrelated-request ')
    .replace(`operationId=${fixture.request.operationId} `, 'operationId=unrelated-request-operation ')
  expect(unrelated).not.toBe(fixture.framedRequest[0])
  writeSim(box, (state) => {
    const pr = state.prs['7']
    if (!pr) throw new Error('fixture-pr-missing')
    pr.comments.push({
      id: 30000,
      author: 'operator',
      body: unrelated,
      createdAt: fixture.date,
      updatedAt: fixture.date,
    })
  })
  const corrupt = read()
  expect(corrupt).toMatchObject({
    accepted: 'refused',
    observation: 'incomplete',
    admission: { framed: false, deliverable: false },
  })
  expect(corrupt.observationDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'incomplete', message: expect.stringContaining('unrelated-request-operation') }),
    ]),
  )
})
