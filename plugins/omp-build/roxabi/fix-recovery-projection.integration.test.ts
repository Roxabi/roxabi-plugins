import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { pullHistory } from '../testing/feature-ci-review-fixture.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../testing/feature-review-fixture.ts'
import { seedFixRecoveryPrefix } from '../testing/fix-recovery-prefix-fixture.ts'
import { readSim, writeSim } from '../testing/sandbox/sandbox-repository.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('projects a confirmed publication close without erasing late retired fragments or unrelated corruption', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  const runner = path.resolve(import.meta.dirname, '../testing/fix-recovery-prefix-reader.ts')
  const read = () => {
    const run = spawnSync(BUN, [runner, cwd], {
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
  const fixture = await seedFixRecoveryPrefix(box, cwd)
  const baseline = fixture.baseline
  expect(baseline).toMatchObject({ accepted: 'accepted', observation: 'complete' })
  const torn = read()
  expect(torn).toMatchObject({
    accepted: 'refused',
    observation: 'incomplete',
    admission: { framed: false, deliverable: false },
    fixRecovery: { status: 'interrupted', owner: fixture.opened, settled: fixture.settled, phase: fixture.interrupted },
  })
  expect(torn.observationDiagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'incomplete', message: expect.stringContaining(fixture.source.operationId) }),
    ]),
  )

  const controlBodies = await fixture.frameClose()
  writeSim(box, (state) => {
    const pr = state.prs['7']
    if (!pr) throw new Error('fixture-pr-missing')
    pr.comments.push(
      ...controlBodies.map((body, index) => ({
        id: 10000 + index,
        author: 'operator',
        body,
        createdAt: fixture.date,
        updatedAt: fixture.date,
      })),
    )
  })
  const closed = read()
  expect(closed, JSON.stringify(closed)).toMatchObject({
    accepted: 'accepted',
    observation: 'complete',
    admission: baseline.admission,
  })
  const initialRaw = readSim(box).prs['7']?.comments.map((comment) => comment.body)
  expect(initialRaw).toContain(fixture.framedSource[0])
  expect(pullHistory(box).operations.find((item) => item.operationId === fixture.source.operationId)?.status).toBe(
    'incomplete',
  )

  writeSim(box, (state) => {
    const pr = state.prs['7']
    if (!pr) throw new Error('fixture-pr-missing')
    pr.comments.push(
      ...fixture.framedSource.slice(1).map((body, index) => ({
        id: 20000 + index,
        author: 'operator',
        body,
        createdAt: fixture.date,
        updatedAt: fixture.date,
      })),
    )
  })
  const completedRaw = pullHistory(box)
  expect(completedRaw.operations.find((item) => item.operationId === fixture.source.operationId)).toMatchObject({
    status: 'complete',
    record: { kind: 'contribution', recordId: fixture.source.recordId },
  })
  expect(
    completedRaw.operations.some((item) => item.record?.kind === 'fix-request' || item.record?.kind === 'decision'),
  ).toBe(false)
  const late = read()
  expect(late, JSON.stringify(late)).toMatchObject({
    accepted: 'accepted',
    observation: 'complete',
    admission: baseline.admission,
  })
  const comments = readSim(box).prs['7']?.comments.map((comment) => comment.body) ?? []
  expect(comments).toEqual(expect.arrayContaining([...fixture.framedSource, ...controlBodies]))
  expect(comments).toEqual(expect.arrayContaining(initialRaw ?? []))

  const firstPart = fixture.framedSource[0]
  if (firstPart === undefined) throw new Error('fixture-source-part-missing')
  const unrelated = firstPart
    .replace(`id=${fixture.source.recordId} `, 'id=unrelated-source ')
    .replace(`operationId=${fixture.source.operationId} `, 'operationId=unrelated-operation ')
  expect(unrelated).not.toBe(fixture.framedSource[0])
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
      expect.objectContaining({ code: 'incomplete', message: expect.stringContaining('unrelated-operation') }),
    ]),
  )
})
