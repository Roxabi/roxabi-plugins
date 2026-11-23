import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { readGitHubHistory } from '../../adapters/github/transport.ts'
import { arrangeReviewFixture, seedReviewFixture } from '../../testing/feature-review-fixture.ts'
import { seedFixRecoveryPrefix } from '../../testing/fix-recovery-prefix-fixture.ts'
import { writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import { recoveryRetiredParts } from '../fix-recovery-projection.ts'

const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('refuses edited or malformed late retired fragments while retaining valid incomplete fragments', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  const fixture = await seedFixRecoveryPrefix(box, cwd)
  expect(fixture.framedSource.length).toBeGreaterThan(2)
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
  const options = {
    cwd,
    readAuthor: 'operator',
    gh: async (dir: string, args: string[]) => execFileSync('gh', args, { cwd: dir, env: box.env, encoding: 'utf8' }),
  }
  const home = decodeHistory(await readGitHubHistory(fixture.uw, options))
  const pull = decodeHistory(await readGitHubHistory(fixture.pullRequest, options))
  const body = fixture.framedSource[1]
  if (!body) throw new Error('fixture-late-part-missing')
  const late = {
    locator: `${fixture.pullRequest.target}:comment:20000`,
    nativeId: '20000',
    author: 'operator',
    body,
    createdAt: fixture.date,
    updatedAt: fixture.date,
  }
  const withLate = (createdAt: string | null, updatedAt: string | null) =>
    decodeHistory({
      ...pull.source,
      comments: [...pull.source.comments, { ...late, createdAt, updatedAt }],
    })
  const intact = withLate(fixture.date, fixture.date)
  expect(intact.operations.find((operation) => operation.operationId === fixture.source.operationId)?.status).toBe(
    'incomplete',
  )
  expect(recoveryRetiredParts([home, intact]).ok).toBe(true)
  for (const [createdAt, updatedAt] of [
    [fixture.date, '2026-10-27T12:01:00Z'],
    ['not-a-date', 'not-a-date'],
    [null, null],
    [fixture.date, null],
  ] as const) {
    const observed = withLate(createdAt, updatedAt)
    expect(observed.operations.find((operation) => operation.operationId === fixture.source.operationId)?.status).toBe(
      'incomplete',
    )
    expect(recoveryRetiredParts([home, observed]).ok, `${createdAt}/${updatedAt}`).toBe(false)
  }
})
