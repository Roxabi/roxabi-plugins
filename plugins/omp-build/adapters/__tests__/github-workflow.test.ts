import { describe, expect, it } from 'vitest'
import type { DecodedHistory, History } from '../../engine/history-schema.ts'
import { parseRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { ObservedComment } from '../../engine/review-schema.ts'
import { buildFixOnlyMandate } from '../../engine/workflow-correction-mandate.ts'
import { decodeHistory, encodeRecord, type Gh, githubScope } from '../github.ts'
import {
  publishConfirmedWorkflowRecord,
  readComposedWorkflowHistory,
  readIssueParentAssociation,
  readLandingFacts,
  readLinkedIssueAssociation,
  resolveNativeScope,
  resolveNativeTarget,
} from '../github-workflow.ts'

const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BASE_TIP = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

function comment(body: string, author = 'automation', nativeId = '100'): ObservedComment {
  return {
    locator: `acme/app#42:comment:${nativeId}`,
    nativeId,
    body,
    author,
    createdAt: '2026-10-21T00:00:00Z',
    updatedAt: '2026-10-21T00:00:01Z',
  }
}

function framed(kind: string, operationId: string, recordId: string): string {
  const record = {
    repository: 'acme/app',
    target: 'acme/app#42',
    version: 1,
    recordId,
    runId: 'run-1',
    operationId,
    inputs: [],
    kind,
    payload:
      kind === 'stop'
        ? { reason: 'ci-failed', reviewId: 'review-1', detail: {} }
        : kind === 'proof'
          ? { candidateGitSHA: 'abc', data: { verified: true } }
          : { retained: true },
  }
  // Unknown workflow payloads stay framed for authority classification even when schema parse fails.
  return `<!-- omp-build-record v=1 kind=${kind} id=${recordId} operationId=${operationId} part=1/1 data=${Buffer.from(JSON.stringify(record)).toString('base64url')} -->\n# ${kind}`
}

function historyFrom(body: string, author = 'automation', stopAuthor: string | null = null): History {
  return {
    scope: githubScope('acme/app', 42),
    expectedAuthor: 'automation',
    stopAuthor,
    complete: true,
    comments: [comment(body, author)],
    diagnostics: [],
  }
}

function prView(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    number: 42,
    state: 'OPEN',
    headRefOid: HEAD,
    headRefName: 'feat/7-work',
    baseRefName: 'main',
    baseRefOid: BASE_TIP,
    author: { login: 'operator' },
    ...overrides,
  })
}
function mustRecord(
  result: { ok: true; value: CanonicalRecord } | { ok: false; diagnostics: { code: string }[] },
): CanonicalRecord {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}

function wire(record: CanonicalRecord): string {
  const text = JSON.stringify(record)
  return `<!-- omp-build-record v=1 kind=${record.kind} id=${record.recordId} operationId=${record.operationId} part=1/1 data=${Buffer.from(text).toString('base64url')} -->\n# ${record.kind}`
}

function issueMandate(scope: Scope, recordId = 'mandate-1', parent: CanonicalRecord | null = null): CanonicalRecord {
  return mustRecord(
    buildFixOnlyMandate({
      scope,
      recordId,
      runId: 'run-1',
      operationId: `op-${recordId}`,
      branch: 'feat/7-work',
      base: 'main',
      lineageHead: null,
      productVersion: '0.11.0',
      work: { reference: scope.target, body: 'live linked issue body', lastEditedAt: '2026-10-21T00:00:00Z' },
      config: {
        version: 'catalogue-1',
        digest: 'a'.repeat(64),
        effective: {
          graph: {
            version: 1,
            productVersion: '0.11.0',
            configVersion: 'catalogue-1',
            edgeOrder: 'array',
            nodes: [
              { id: 'frame', action: 'frame' },
              { id: 'land', action: 'land' },
            ],
            edges: [{ from: 'frame', to: 'land', when: 'always' }],
            initial: 'land',
          },
        },
      },
      proofPins: [],
      parent:
        parent === null
          ? null
          : {
              scope: { repository: parent.repository, target: parent.target },
              recordId: parent.recordId,
              kind: 'mandate',
            },
      antecedent: null,
    }),
  )
}

function bindingRecord(mandate: CanonicalRecord): CanonicalRecord {
  return mustRecord(
    parseRecord({
      repository: 'acme/app',
      target: 'acme/app#42',
      version: 1,
      recordId: 'bind-1',
      runId: 'run-1',
      operationId: 'op-bind-1',
      inputs: [],
      kind: 'workflow-binding',
      payload: {
        mandate: {
          scope: { repository: mandate.repository, target: mandate.target },
          recordId: mandate.recordId,
          kind: 'mandate',
        },
        branch: 'feat/7-work',
        base: 'main',
      },
    }),
  )
}

function nativeComment(id: number, body: string) {
  return {
    id,
    body,
    user: { login: 'automation' },
    created_at: '2026-10-21T00:00:00Z',
    updated_at: '2026-10-21T00:00:01Z',
  }
}
function closingGraphql(nodes: Array<{ number: number }>, totalCount = nodes.length) {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          headRefName: 'feat/7-work',
          baseRefName: 'main',
          headRefOid: HEAD,
          baseRefOid: BASE_TIP,
          closingIssuesReferences: { totalCount, nodes },
        },
      },
    },
  })
}

function fakeGh(handlers: Array<(args: string[]) => string | undefined>): Gh {
  return async (_cwd, args) => {
    for (const handler of handlers) {
      const value = handler(args)
      if (value !== undefined) return value
    }
    throw new Error(`unexpected gh args: ${args.join(' ')}`)
  }
}

describe('GitHub workflow kind classification', () => {
  it('accounts mandate, operator-control, and action-receipt without stop-bot privileges', () => {
    for (const kind of ['mandate', 'operator-control', 'action-receipt'] as const) {
      const trusted = decodeHistory(historyFrom(framed(kind, `op-${kind}`, `${kind}-1`)))
      expect(trusted.operations[0]).toMatchObject({
        kind,
        authority: 'accounted',
        claimedKinds: [kind],
      })

      const stopBot = decodeHistory(
        historyFrom(framed(kind, `op-${kind}-bot`, `${kind}-bot`), 'github-actions[bot]', 'github-actions[bot]'),
      )
      expect(stopBot.operations[0]).toMatchObject({
        kind,
        authority: 'foreign',
        status: 'invalid',
        record: null,
      })
      expect(stopBot.diagnostics.map((entry) => entry.code)).toContain('native-author-mismatch')
    }
  })

  it('keeps a foreign mandate visible instead of treating it as absence', () => {
    const decoded = decodeHistory(
      historyFrom(framed('mandate', 'op-foreign-mandate', 'mandate-foreign'), 'other-actor'),
    )
    expect(decoded.operations).toHaveLength(1)
    expect(decoded.operations[0]).toMatchObject({
      kind: 'mandate',
      authority: 'foreign',
      status: 'invalid',
      record: null,
    })
    expect(decoded.diagnostics.map((entry) => entry.code)).toContain('native-author-mismatch')
  })

  it('does not let workflow kinds share stop authority when headers collide with stop', () => {
    const source = historyFrom(framed('mandate', 'shared-op', 'mandate-1'))
    const [mandateComment] = source.comments
    if (mandateComment === undefined) throw new Error('fixture requires mandate comment')
    source.stopAuthor = 'github-actions[bot]'
    source.comments = [
      mandateComment,
      {
        ...mandateComment,
        locator: 'acme/app#42:comment:99',
        nativeId: '99',
        author: 'github-actions[bot]',
        body: framed('stop', 'shared-op', 'stop-1'),
      },
    ]
    const decoded = decodeHistory(source)
    expect(decoded.operations).toEqual([
      expect.objectContaining({
        operationId: 'shared-op',
        status: 'conflict',
        claimedKinds: ['mandate', 'stop'],
        authority: 'authority',
      }),
    ])
  })
})

describe('native target and association reads', () => {
  it('resolves an existing issue without creating a ticket', async () => {
    const resolved = await resolveNativeTarget(7, {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) =>
          args[0] === 'repo' && args[1] === 'view' ? JSON.stringify({ nameWithOwner: 'acme/app' }) : undefined,
        (args) =>
          args[0] === 'api' && args[1] === 'repos/acme/app/issues/7'
            ? JSON.stringify({ number: 7, state: 'open', user: { login: 'operator' }, body: 'exact spec body' })
            : undefined,
      ]),
    })
    expect(resolved).toEqual({
      status: 'issue',
      scope: githubScope('acme/app', 7),
      issue: {
        repository: 'acme/app',
        number: 7,
        state: 'OPEN',
        author: 'operator',
        body: 'exact spec body',
        isPullRequest: false,
      },
    })
  })

  it('resolves a recorded scope in its declared repository without cwd fallback', async () => {
    const calls: string[][] = []
    const resolved = await resolveNativeScope(
      { repository: 'acme/parent', target: 'acme/parent#7' },
      {
        cwd: '/fixture',
        readAuthor: 'automation',
        gh: async (_cwd, args) => {
          calls.push(args)
          if (args[0] === 'api' && args[1] === 'repos/acme/parent/issues/7')
            return JSON.stringify({ number: 7, state: 'open', user: { login: 'operator' }, body: 'parent spec' })
          throw new Error(`Unexpected gh call: ${args.join(' ')}`)
        },
      },
    )
    expect(calls).toEqual([['api', 'repos/acme/parent/issues/7']])
    expect(resolved).toMatchObject({ status: 'issue', scope: githubScope('acme/parent', 7) })
  })

  it('refuses a recorded scope whose target does not match its repository', async () => {
    const resolved = await resolveNativeScope(
      { repository: 'acme/parent', target: 'acme/other#7' },
      {
        cwd: '/fixture',
        readAuthor: 'automation',
        gh: async () => {
          throw new Error('GitHub must not be read for a mismatched scope')
        },
      },
    )
    expect(resolved).toMatchObject({
      status: 'refused',
      diagnostics: [expect.objectContaining({ code: 'invalid-scope' })],
    })
  })

  it('resolves a pull request with head and base facts', async () => {
    const resolved = await resolveNativeTarget(
      '#42',
      {
        cwd: '/fixture',
        readAuthor: 'automation',
        gh: fakeGh([
          (args) =>
            args[0] === 'api' && args[1] === 'repos/acme/app/issues/42'
              ? JSON.stringify({
                  number: 42,
                  state: 'open',
                  user: { login: 'operator' },
                  body: 'pr issue body',
                  pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/42' },
                })
              : undefined,
          (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        ]),
      },
      'acme/app',
    )
    expect(resolved).toMatchObject({
      status: 'pull-request',
      scope: githubScope('acme/app', 42),
      pullRequest: {
        repository: 'acme/app',
        pr: 42,
        head: HEAD,
        base: 'main',
        baseTip: BASE_TIP,
        branch: 'feat/7-work',
      },
    })
  })

  it('reports linked, none, and ambiguous closing-issue associations explicitly', async () => {
    const options = {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => (args.includes('graphql') ? closingGraphql([{ number: 7 }]) : undefined),
      ]),
    }
    await expect(readLinkedIssueAssociation('acme/app', 42, options)).resolves.toEqual({
      status: 'linked',
      scope: githubScope('acme/app', 7),
      number: 7,
    })

    const none = await readLinkedIssueAssociation('acme/app', 42, {
      ...options,
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => (args.includes('graphql') ? closingGraphql([]) : undefined),
      ]),
    })
    expect(none).toEqual({ status: 'none' })

    const ambiguous = await readLinkedIssueAssociation('acme/app', 42, {
      ...options,
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => (args.includes('graphql') ? closingGraphql([{ number: 7 }, { number: 8 }]) : undefined),
      ]),
    })
    expect(ambiguous).toMatchObject({ status: 'ambiguous' })
  })

  it('refuses incomplete closing-issue pagination instead of inventing absence', async () => {
    const result = await readLinkedIssueAssociation('acme/app', 42, {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => (args.includes('graphql') ? closingGraphql([{ number: 7 }], 2) : undefined),
      ]),
    })
    expect(result).toMatchObject({ status: 'incomplete' })
  })

  it('keeps a non-default base and does not invent a link from closing-keyword text', async () => {
    const stagingView = () => prView({ baseRefName: 'staging', body: 'Closes #7\n\nstaging-train feature PR' })
    const emptyClosing = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefName: 'feat/7-work',
            baseRefName: 'staging',
            headRefOid: HEAD,
            baseRefOid: BASE_TIP,
            closingIssuesReferences: { totalCount: 0, nodes: [] },
          },
        },
      },
    })
    const association = await readLinkedIssueAssociation('acme/app', 42, {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? stagingView() : undefined),
        (args) => (args.includes('graphql') ? emptyClosing : undefined),
      ]),
    })
    expect(association).toEqual({ status: 'none' })

    const landing = await readLandingFacts(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? stagingView() : undefined),
        (args) => (args.includes('graphql') ? emptyClosing : undefined),
        (args) =>
          args[0] === 'api' && String(args[1] ?? '').includes('/issues/42/comments') ? JSON.stringify([]) : undefined,
      ]),
    })
    expect(landing.ok).toBe(false)
    if (landing.ok) throw new Error('closing text must not bind a staging PR')
    expect(landing.reason).toBe('absent')
  })

  it('reads a parent issue association for child mandate binding', async () => {
    const linked = await readIssueParentAssociation('acme/app', 7, {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) =>
          args.includes('graphql')
            ? JSON.stringify({
                data: {
                  repository: {
                    issue: {
                      number: 7,
                      parent: { number: 3, repository: { nameWithOwner: 'acme/app' } },
                    },
                  },
                },
              })
            : undefined,
      ]),
    })
    expect(linked).toEqual({ status: 'linked', scope: githubScope('acme/app', 3), number: 3 })
  })
})

it('threads externalHistories through encodeRecord into projection', () => {
  const record = {
    repository: 'acme/app',
    target: 'acme/app#42',
    version: 1 as const,
    recordId: 'proof-external',
    runId: 'run-1',
    operationId: 'op-external',
    inputs: [] as string[],
    kind: 'proof' as const,
    payload: { candidateGitSHA: 'abc', data: { verified: true } },
  }
  const source = {
    scope: githubScope('acme/app', 42),
    expectedAuthor: 'automation',
    stopAuthor: null,
    complete: true,
    comments: [] as [],
    diagnostics: [] as [],
  }
  const foreign = decodeHistory({
    ...source,
    scope: githubScope('acme/app', 7),
    comments: [],
  })
  const encoded = encodeRecord(record, source, null, [foreign])
  expect(encoded.ok).toBe(true)
})

describe('composed scoped history and landing facts', () => {
  it('composes PR and linked issue histories for a cold read', async () => {
    const issueBody = framed('proof', 'op-issue', 'proof-issue')
    const prBody = framed('proof', 'op-pr', 'proof-pr')
    const result = await readComposedWorkflowHistory([githubScope('acme/app', 42), githubScope('acme/app', 7)], {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => {
          const path = args[1] ?? ''
          if (path.includes('/issues/42/comments')) {
            return JSON.stringify([
              {
                id: 1,
                body: prBody,
                user: { login: 'automation' },
                created_at: '2026-10-21T00:00:00Z',
                updated_at: '2026-10-21T00:00:01Z',
              },
            ])
          }
          if (path.includes('/issues/7/comments')) {
            return JSON.stringify([
              {
                id: 2,
                body: issueBody.replaceAll('acme/app#42', 'acme/app#7'),
                user: { login: 'automation' },
                created_at: '2026-10-21T00:00:00Z',
                updated_at: '2026-10-21T00:00:01Z',
              },
            ])
          }
          return undefined
        },
      ]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected composed history')
    expect(result.histories).toHaveLength(2)
    expect(result.histories.map((entry) => entry.source.scope.target)).toEqual(['acme/app#42', 'acme/app#7'])
  })

  it('refuses composed history when a scope comment page is unreadable', async () => {
    const refused = await readComposedWorkflowHistory([githubScope('acme/app', 42)], {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => {
          if (String(args[1] ?? '').includes('/comments')) return '{"not":"an-array"}'
          return undefined
        },
      ]),
    })
    expect(refused).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('does not treat closing-issue ambiguity as a landing binding', async () => {
    const refused = await readLandingFacts(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => (args.includes('graphql') ? closingGraphql([{ number: 7 }, { number: 8 }]) : undefined),
        (args) =>
          args[0] === 'api' && String(args[1] ?? '').includes('/issues/42/comments') ? JSON.stringify([]) : undefined,
      ]),
    })
    expect(refused).toMatchObject({ ok: false, reason: 'absent' })
  })

  it('follows a confirmed workflow-binding and ignores tracker parentage', async () => {
    const mandate = issueMandate(githubScope('acme/app', 7))
    const binding = bindingRecord(mandate)
    const result = await readLandingFacts(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) =>
          args.includes('graphql')
            ? JSON.stringify({
                data: { repository: { issue: { number: 7, parent: { number: 3 } } } },
              })
            : undefined,
        (args) =>
          args[0] === 'api' && String(args[1] ?? '') === 'repos/acme/app/issues/7'
            ? JSON.stringify({ number: 7, state: 'open', user: { login: 'operator' }, body: 'live linked issue body' })
            : undefined,
        (args) => {
          const path = args[1] ?? ''
          if (path.includes('/issues/42/comments')) return JSON.stringify([nativeComment(1, wire(binding))])
          if (path.includes('/issues/7/comments')) return JSON.stringify([nativeComment(2, wire(mandate))])
          return undefined
        },
      ]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected a confirmed binding')
    expect(result.native).toEqual({
      branch: 'feat/7-work',
      base: 'main',
      pullRequest: githubScope('acme/app', 42),
      linkedIssueScopes: [githubScope('acme/app', 7)],
    })
    expect(result.observed).toEqual({ head: HEAD, baseTip: BASE_TIP })
    expect(result.linkedIssueBodies).toEqual([{ scope: githubScope('acme/app', 7), body: 'live linked issue body' }])
    expect(result.parentScopes).toEqual([])
    expect(result.histories.map((entry) => entry.source.scope.target)).toEqual(['acme/app#42', 'acme/app#7'])
    expect(result.binding.recordId).toBe('bind-1')
  })

  it('refuses a present malformed binding instead of treating it as absent', async () => {
    const refused = await readLandingFacts(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) =>
          args[0] === 'api' && String(args[1] ?? '').includes('/issues/42/comments')
            ? JSON.stringify([nativeComment(1, framed('workflow-binding', 'op-bad', 'bind-bad'))])
            : undefined,
      ]),
    })
    expect(refused).toMatchObject({ ok: false, reason: 'incomplete' })
  })

  it('refuses landing facts when the bound mandate body is missing', async () => {
    const mandate = issueMandate(githubScope('acme/app', 7))
    const binding = bindingRecord(mandate)
    const refused = await readLandingFacts(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) =>
          args[0] === 'api' && String(args[1] ?? '') === 'repos/acme/app/issues/7'
            ? JSON.stringify({ number: 7, state: 'open', user: { login: 'operator' }, body: null })
            : undefined,
        (args) => {
          const path = args[1] ?? ''
          if (path.includes('/issues/42/comments')) return JSON.stringify([nativeComment(1, wire(binding))])
          if (path.includes('/issues/7/comments')) return JSON.stringify([nativeComment(2, wire(mandate))])
          return undefined
        },
      ]),
    })
    expect(refused).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('never treats uncertain publication as a confirmed workflow checkpoint', async () => {
    const record = {
      repository: 'acme/app',
      target: 'acme/app#42',
      version: 1 as const,
      recordId: 'proof-uncertain',
      runId: 'run-1',
      operationId: 'op-uncertain',
      inputs: [] as string[],
      kind: 'proof' as const,
      payload: { candidateGitSHA: 'abc', data: { verified: true } },
    }
    const empty: DecodedHistory = {
      source: {
        scope: githubScope('acme/app', 42),
        expectedAuthor: 'automation',
        stopAuthor: null,
        complete: true,
        comments: [],
        diagnostics: [],
      },
      operations: [],
      diagnostics: [],
    }
    const published = await publishConfirmedWorkflowRecord(
      record,
      empty,
      {
        cwd: '/fixture',
        readAuthor: 'automation',
        writeAuthor: 'automation',
        writerLogin: 'automation',
        gh: fakeGh([
          (args) => {
            if (args[0] === 'api' && String(args[1] ?? '').includes('/comments') && !args.includes('--method')) {
              return '[]'
            }
            if (args.includes('--method') && args.includes('POST')) throw new Error('simulated outage')
            return undefined
          },
        ]),
      },
      null,
    )
    expect(published.status).toBe('uncertain')
    if (published.status === 'confirmed') throw new Error('outage must not confirm')
    expect(published.diagnostics.map((entry) => entry.code)).toContain('github-write-uncertain')
  })
})
