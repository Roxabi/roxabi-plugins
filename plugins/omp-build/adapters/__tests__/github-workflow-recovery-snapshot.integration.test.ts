import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import { arrangeReviewFixture, seedReviewFixture } from '../../testing/feature-review-fixture.ts'
import { seedFixRecoveryPrefix } from '../../testing/fix-recovery-prefix-fixture.ts'
import { writeSim } from '../../testing/sandbox/sandbox-repository.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { readGitHubHistory } from '../github/transport.ts'
import { readComposedWorkflowHistory } from '../github-workflow/history.ts'

const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

it('compares closure-loaded UW raw sources while returning only effective requested PR history', async () => {
  const { box, cwd } = arrangeReviewFixture()
  roots.add(box.root)
  await seedReviewFixture(box, cwd)
  // The request is intentionally framed at a 400-byte adapter-test limit, not the production limit.
  const fixture = await seedFixRecoveryPrefix(box, cwd, 'torn-request')
  const post = (body: string) =>
    execFileSync('gh', ['api', '--method', 'POST', 'repos/acme/app/issues/7/comments', '-f', `body=${body}`], {
      cwd,
      env: box.env,
      encoding: 'utf8',
    })
  for (const body of await fixture.frameClose()) post(body)
  for (const body of fixture.framedRequest.slice(1)) post(body)

  const options = {
    cwd,
    readAuthor: 'operator',
    gh: async (dir: string, args: string[]) => execFileSync('gh', args, { cwd: dir, env: box.env, encoding: 'utf8' }),
  }
  const primary = decodeHistory(await readGitHubHistory(fixture.uw, options))
  expect(primary.operations.some((operation) => operation.record?.kind === 'fix-owner')).toBe(true)
  // Effective operations may differ; the native source itself is exactly the same snapshot.
  const knownEffective = { ...primary, operations: [] }
  const composed = await readComposedWorkflowHistory([fixture.pullRequest], options, [knownEffective])
  expect(composed.ok, JSON.stringify(composed)).toBe(true)
  if (!composed.ok) throw new Error('expected effective PR history')
  expect(composed.scopes).toEqual([fixture.pullRequest])
  expect(composed.histories).toHaveLength(1)
  expect(composed.histories[0]?.source.scope).toEqual(fixture.pullRequest)
  expect(
    composed.histories[0]?.operations.some((operation) => operation.operationId === fixture.request.operationId),
  ).toBe(false)
  expect(
    composed.histories[0]?.operations.some((operation) => operation.operationId === fixture.source.operationId),
  ).toBe(true)
  expect(
    composed.records.some((record) => record.kind === 'fix-request' && record.recordId === fixture.request.recordId),
  ).toBe(false)
  expect(composed.records.some((record) => record.target === fixture.uw.target)).toBe(false)
  expect(composed.histories[0]?.source.comments.map((comment) => comment.body)).toEqual(
    expect.arrayContaining(fixture.framedRequest),
  )

  // A later UW native read differs from the previously captured primary, even though the added comment is not a protocol record.
  writeSim(box, (state) => {
    const issue = state.issues['42']
    if (!issue) throw new Error('fixture-issue-missing')
    issue.comments.push({
      id: 39000,
      author: 'operator',
      body: 'unrelated later human comment',
      createdAt: fixture.date,
      updatedAt: fixture.date,
    })
  })
  const changed = await readComposedWorkflowHistory([fixture.pullRequest], options, [knownEffective])
  expect(changed).toMatchObject({
    ok: false,
    reason: 'ambiguous',
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'ambiguous', message: 'Recovery source changed between native observations' }),
    ]),
  })
  expect(changed.histories.map((history) => history.source.scope)).toEqual([fixture.pullRequest])
})
