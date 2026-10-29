import { describe, expect, it } from 'vitest'
import type { History } from '../../engine/history-schema.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { publishMissingBodies } from '../github/publication-writer.ts'
import { githubScope, readGitHubHistory } from '../github/transport.ts'

const handcraftedBody =
  '<!-- omp-build-record v=1 kind=epic-event id=event-1 operationId=operation-1 part=1/1 data=eyJyZXBvc2l0b3J5IjoiYWNtZS9hcHAiLCJ0YXJnZXQiOiJhY21lL2FwcCM0MiIsInZlcnNpb24iOjEsInJlY29yZElkIjoiZXZlbnQtMSIsInJ1bklkIjoicnVuLTEiLCJvcGVyYXRpb25JZCI6Im9wZXJhdGlvbi0xIiwiaW5wdXRzIjpbXSwia2luZCI6ImVwaWMtZXZlbnQiLCJwYXlsb2FkIjp7Im91dGNvbWUiOiJ2ZXJpZmllZCJ9fQ -->\n# Retained projection'

function history(body: string, author = 'automation'): History {
  return {
    scope: githubScope('acme/app', 42),
    expectedAuthor: 'automation',
    stopAuthor: null,
    complete: true,
    comments: [
      {
        locator: 'acme/app#42:comment:100',
        nativeId: '100',
        body,
        author,
        createdAt: '2026-10-21T00:00:00Z',
        updatedAt: '2026-10-21T00:00:00Z',
      },
    ],
    diagnostics: [],
  }
}

describe('GitHub record codec', () => {
  it('decodes a handcrafted canonical native record without parsing its projection', () => {
    const decoded = decodeHistory(history(handcraftedBody))

    expect(decoded.diagnostics).toEqual([])
    expect(decoded.operations).toHaveLength(1)
    expect(decoded.operations[0]).toMatchObject({
      operationId: 'operation-1',
      recordId: 'event-1',
      kind: 'epic-event',
      status: 'complete',
      record: { kind: 'epic-event', payload: { outcome: 'verified' } },
    })
  })

  it('keeps a foreign opaque event observable without authority', () => {
    const decoded = decodeHistory(history(handcraftedBody, 'other-actor'))

    expect(decoded.operations).toEqual([
      expect.objectContaining({ operationId: 'operation-1', status: 'invalid', authority: 'foreign', record: null }),
    ])
    expect(decoded.diagnostics).toEqual([])
  })

  it('keeps a trusted stop when a malformed foreign header shares its operation identity', () => {
    const stop = {
      repository: 'acme/app',
      target: 'acme/app#42',
      version: 1,
      recordId: 'stop-1',
      runId: 'run-1',
      operationId: 'shared-operation',
      inputs: [],
      kind: 'stop',
      payload: { reason: 'ci-failed', reviewId: 'review-1', detail: {} },
    }
    const stopBody = `<!-- omp-build-record v=1 kind=stop id=stop-1 operationId=shared-operation part=1/1 data=${Buffer.from(JSON.stringify(stop)).toString('base64url')} -->\n# Stop`
    const malformed =
      '<!-- omp-build-record v=1 kind=unknown id=stop-1 operationId=shared-operation part=1/1 -->\n# Foreign'
    const source = history(stopBody)
    const [stopComment] = source.comments
    if (stopComment === undefined) throw new Error('Fixture requires a stop comment')
    source.comments = [
      {
        ...stopComment,
        locator: 'acme/app#42:comment:99',
        nativeId: '99',
        body: malformed,
        author: 'foreign',
      },
      stopComment,
    ]

    const decoded = decodeHistory(source)

    expect(decoded.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: 'shared-operation',
          kind: 'stop',
          status: 'complete',
          authority: 'authority',
          parts: [expect.objectContaining({ nativeId: '100' })],
        }),
        expect.objectContaining({
          operationId: 'shared-operation',
          kind: 'unknown',
          status: 'invalid',
          authority: 'foreign',
        }),
      ]),
    )
    expect(decoded.diagnostics).toEqual([])
  })

  it('posts over an identical foreign body', async () => {
    const trusted = decodeHistory(history(handcraftedBody))
    const record = trusted.operations[0]?.record
    if (record === null || record === undefined) throw new Error('Fixture requires a decoded record')
    const calls: string[][] = []
    const response = JSON.stringify({
      id: 101,
      body: handcraftedBody,
      user: { login: 'automation' },
      created_at: '2026-10-21T00:00:00Z',
      updated_at: '2026-10-21T00:00:00Z',
    })

    const result = await publishMissingBodies(
      record,
      [handcraftedBody],
      decodeHistory(history(handcraftedBody, 'other-actor')),
      {
        cwd: '/fixture',
        gh: async (_cwd, args) => {
          calls.push(args)
          return response
        },
      },
      'automation',
      'automation',
      null,
    )

    expect(result).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual([
      'api',
      '--method',
      'POST',
      'repos/acme/app/issues/42/comments',
      '-f',
      `body=${handcraftedBody}`,
    ])
  })

  it('keeps a bot-authored non-stop record observable without authority', () => {
    const stop = {
      repository: 'acme/app',
      target: 'acme/app#42',
      version: 1,
      recordId: 'stop-2',
      runId: 'run-1',
      operationId: 'payload-stop',
      inputs: [],
      kind: 'stop',
      payload: { reason: 'ci-failed', reviewId: 'review-1', detail: {} },
    }
    const body = `<!-- omp-build-record v=1 kind=epic-event id=stop-2 operationId=payload-stop part=1/1 data=${Buffer.from(JSON.stringify(stop)).toString('base64url')} -->\n# Mismatch`

    const source = history(body, 'ci-stop-bot')
    source.stopAuthor = 'ci-stop-bot'
    const decoded = decodeHistory(source)

    expect(decoded.operations).toEqual([
      expect.objectContaining({ operationId: 'payload-stop', status: 'invalid', authority: 'foreign', record: null }),
    ])
    expect(decoded.diagnostics).toEqual([])
  })

  it('retains both raw parts when a stop header collides with an opaque event operation', () => {
    const source = history(handcraftedBody)
    const [eventComment] = source.comments
    if (eventComment === undefined) throw new Error('Fixture requires an event comment')
    source.comments = [
      eventComment,
      {
        ...eventComment,
        locator: 'acme/app#42:comment:99',
        nativeId: '99',
        body: '<!-- omp-build-record v=1 kind=stop id=event-1 operationId=operation-1 part=1/1 data=QQ -->\n# Stop',
      },
    ]

    const decoded = decodeHistory(source)

    expect(decoded.operations).toEqual([
      expect.objectContaining({
        operationId: 'operation-1',
        status: 'conflict',
        claimedKinds: ['epic-event', 'stop'],
        authority: 'authority',
        parts: [expect.objectContaining({ nativeId: '100' }), expect.objectContaining({ nativeId: '99' })],
      }),
    ])
    expect(decoded.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'conflicting-duplicate', operationId: 'operation-1' }),
    )
  })

  it('retains source pagination order while ordering framed parts by their declared index', () => {
    const source = history(
      '<!-- omp-build-record v=1 kind=epic-event id=event-2 operationId=operation-2 part=2/3 data=QQ -->\n# Part two',
    )
    const [secondEventComment] = source.comments
    if (secondEventComment === undefined) throw new Error('Fixture requires an event comment')
    source.comments = [
      secondEventComment,
      {
        ...secondEventComment,
        locator: 'acme/app#42:comment:99',
        nativeId: '99',
        body: '<!-- omp-build-record v=1 kind=epic-event id=event-2 operationId=operation-2 part=1/3 data=QQ -->\n# Part one',
      },
    ]

    const decoded = decodeHistory(source)

    expect(decoded.source.comments.map((comment) => comment.nativeId)).toEqual(['100', '99'])
    expect(decoded.operations[0]).toMatchObject({
      operationId: 'operation-2',
      status: 'incomplete',
      record: null,
      authority: 'accounted',
    })
    expect(decoded.operations[0]?.parts.map((part) => part.nativeId)).toEqual(['99', '100'])
  })

  it('refuses framed proof records with the incompatible-format diagnostic', () => {
    const proof = {
      repository: 'acme/app',
      target: 'acme/app#42',
      version: 1,
      recordId: 'proof-1',
      runId: 'run-1',
      operationId: 'operation-proof',
      inputs: [],
      kind: 'proof',
      payload: { candidateGitSHA: 'abc', data: { verified: true } },
    }
    const body = `<!-- omp-build-record v=1 kind=proof id=proof-1 operationId=operation-proof part=1/1 data=${Buffer.from(
      JSON.stringify(proof),
    ).toString('base64url')} -->\n# Removed proof`
    const decoded = decodeHistory(history(body))

    expect(decoded.operations[0]).toMatchObject({ kind: 'proof', status: 'invalid', record: null })
    expect(decoded.diagnostics).toContainEqual(expect.objectContaining({ code: 'incompatible-format' }))
  })

  it('preserves old markers as explicit legacy refusals', () => {
    const decoded = decodeHistory(history('<!-- omp-build:proof producer=semctx -->\nold body'))

    expect(decoded.operations[0]).toMatchObject({ kind: 'proof', status: 'legacy', record: null })
    expect(decoded.diagnostics.map((entry) => entry.code)).toContain('legacy-format')
  })

  it('reads every GitHub comment page with native metadata intact', async () => {
    const calls: string[] = []
    const received = await readGitHubHistory(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: async (_cwd, args) => {
        calls.push(args[1] ?? '')
        return args[1]?.endsWith('page=1')
          ? JSON.stringify(
              Array.from({ length: 100 }, (_, index) => ({
                id: index + 1,
                body: '',
                user: { login: 'automation' },
                created_at: '2026-10-21T00:00:00Z',
                updated_at: '2026-10-21T00:00:01Z',
              })),
            )
          : JSON.stringify([
              {
                id: 101,
                body: '',
                user: { login: 'automation' },
                created_at: '2026-10-21T00:00:00Z',
                updated_at: '2026-10-21T00:00:01Z',
              },
            ])
      },
    })

    expect(calls).toEqual([
      'repos/acme/app/issues/42/comments?per_page=100&page=1',
      'repos/acme/app/issues/42/comments?per_page=100&page=2',
    ])
    expect(received.comments).toHaveLength(101)
    expect(received.comments[100]).toMatchObject({
      nativeId: '101',
      author: 'automation',
      updatedAt: '2026-10-21T00:00:01Z',
    })
  })
})
