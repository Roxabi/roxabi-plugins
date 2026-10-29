import { afterEach, describe, expect, it, vi } from 'vitest'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { githubScope } from '../../adapters/github/transport.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { type DecodedHistory, parseRecord } from '../../dist/contracts.js'
import { recoveryFixture, recoverySmokeCwd } from '../../roxabi/review-recovery-gh-test-support.ts'
import { epicReviewGraph } from '../../testing/record-graphs.ts'
import * as github from './epic-driver-github.ts'
import { publishEpicEvent } from './epic-driver-publication.ts'
import * as runtime from './epic-driver-runtime.ts'

vi.mock('./epic-driver-github.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./epic-driver-github.ts')>()),
  adapterOptions: vi.fn(),
  issueHistory: vi.fn(),
}))
vi.mock('./epic-driver-runtime.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./epic-driver-runtime.ts')>()),
  repoName: vi.fn(),
}))

afterEach(() => vi.restoreAllMocks())

async function seedEpicReview(fixture: { gh: Gh; history: () => Promise<DecodedHistory> }, range: string) {
  const scope = githubScope('acme/app', 42)
  const graph = epicReviewGraph({ scope, range, head: 'c'.repeat(40), prefix: 'owned-epic' })
  for (const record of graph.records) {
    const parsed = parseRecord(record)
    if (!parsed.ok) throw new Error(`invalid review fixture: ${JSON.stringify(parsed.diagnostics)}`)
    const encoded = encodeParts(parsed.value, '', 65536)
    if (!encoded.ok) throw new Error('could not encode existing review fixture')
    for (const body of encoded.value) {
      await fixture.gh(recoverySmokeCwd, [
        'api',
        '--method',
        'POST',
        'repos/acme/app/issues/42/comments',
        '-f',
        `body=${body}`,
      ])
    }
  }
  const seeded = await fixture.history()
  for (const record of graph.records) {
    expect(seeded.operations.find((operation) => operation.recordId === record.recordId)).toMatchObject({
      status: 'complete',
      record: { recordId: record.recordId },
    })
  }
  return graph
}

describe('owned epic review publication', () => {
  it.each([true, false])('fences the native writer after a suspended history read (revoke=%s)', async (revoke) => {
    const fixture = recoveryFixture()
    const range = `${'b'.repeat(40)}..${'c'.repeat(40)}`
    const graph = await seedEpicReview(fixture, range)
    const before = fixture.commentCount()
    const suspended = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first = true
    let owned = true
    const gh: Gh = async (cwd, args) => {
      if (first && args.includes('repos/acme/app/issues/42/comments?per_page=100&page=1')) {
        first = false
        suspended.resolve()
        await release.promise
      }
      return fixture.gh(cwd, args)
    }
    vi.mocked(runtime.repoName).mockReturnValue({ owner: 'acme', name: 'app', full: 'acme/app' })
    vi.mocked(github.issueHistory).mockImplementation(async () => fixture.history())
    vi.mocked(github.adapterOptions).mockReturnValue({
      cwd: recoverySmokeCwd,
      gh,
      automationLogin: 'automation',
      writerLogin: 'automation',
      stopAuthor: 'github-actions[bot]',
    })
    const inputs = [graph.decision.recordId, graph.root.recordId, graph.synthesis.recordId]
    const publication = publishEpicEvent(
      recoverySmokeCwd,
      42,
      'abcd1234',
      'epic-review',
      `${range}:${graph.decision.recordId}`,
      { decisionId: graph.decision.recordId, inventoryIds: inputs.slice(1), range },
      inputs,
      () => owned,
    )
    await Promise.race([
      suspended.promise,
      publication.then(() => {
        throw new Error('publication completed before native history barrier')
      }),
    ])
    if (revoke) owned = false
    release.resolve()
    if (revoke) {
      await expect(publication).rejects.toThrow('publication-ownership-revoked')
      expect(fixture.commentCount()).toBe(before)
    } else {
      await expect(publication).resolves.toBeUndefined()
    }
    const history = await fixture.history()
    const eventId = `epic-event:42:abcd1234:epic-review:${range}:${graph.decision.recordId}`
    const event = history.operations.find((operation) => operation.recordId === eventId)?.record
    if (revoke) expect(event).toBeUndefined()
    else expect(event).toMatchObject({ kind: 'epic-event', payload: { decisionId: graph.decision.recordId, range } })
  })
})
