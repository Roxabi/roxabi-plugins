import { describe, expect, it } from 'vitest'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { decodeHistory, encodeRecord } from '../github/history-codec.ts'
import { githubScope } from '../github/transport.ts'
import { readLinkedIssueAssociation } from '../github-native/relations.ts'
import { publishConfirmedWorkflowRecord, readLandingFacts, readWorkflowBinding } from '../github-workflow/binding.ts'
import { readComposedWorkflowHistory } from '../github-workflow/history.ts'
import {
  bindingRecord,
  closingGraphql,
  fakeGh,
  framed,
  historyFrom,
  issueMandate,
  nativeComment,
  prView,
  wire,
} from './github-workflow-support.ts'

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
      expect(stopBot.operations).toEqual([expect.objectContaining({ authority: 'foreign', record: null })])
      expect(stopBot.diagnostics).toEqual([])
    }
  })
  it('invalidates edited local assessment, material-control, and mandate frames without refusing foreign observations', () => {
    const mandate = issueMandate(githubScope('acme/app', 42), 'mandate-integrity')
    if (mandate.kind !== 'mandate') throw new Error('fixture requires mandate')
    const accepted = mandateAssessmentState(mandate)
    const assessment = assessFixture(
      mandate,
      'assessment-integrity',
      accepted,
      proposedAssessmentState(accepted, { body: 'Editorial assessment revision.' }),
      'material',
    )
    const control = acceptMaterialFixture(mandate, 'control-integrity', assessment)
    for (const record of [assessment.start, control, mandate]) {
      const pristine = decodeHistory(historyFrom(wire(record)))
      expect(pristine.operations[0]).toMatchObject({
        kind: record.kind,
        status: 'complete',
        authority: 'accounted',
        record: { recordId: record.recordId },
      })

      const source = historyFrom(wire(record))
      source.comments = source.comments.map((comment) => ({ ...comment, updatedAt: '2026-10-21T00:00:01Z' }))
      const decoded = decodeHistory(source)
      expect(decoded.operations[0]).toMatchObject({
        kind: record.kind,
        status: 'invalid',
        authority: 'accounted',
        record: null,
        claimedKinds: [record.kind],
      })
      expect(decoded.operations[0]?.parts).toHaveLength(1)
      expect(decoded.diagnostics).toContainEqual(expect.objectContaining({ code: 'record-edited' }))
    }

    const foreignSource = historyFrom(wire(control), 'other-actor')
    foreignSource.comments = foreignSource.comments.map((comment) => ({
      ...comment,
      updatedAt: '2026-10-21T00:00:01Z',
    }))
    const foreign = decodeHistory(foreignSource)
    expect(foreign.operations[0]).toMatchObject({ authority: 'foreign', record: null })
    expect(foreign.diagnostics).toEqual([])
  })

  it('keeps a foreign mandate observable without workflow authority', () => {
    const decoded = decodeHistory(
      historyFrom(framed('mandate', 'op-foreign-mandate', 'mandate-foreign'), 'other-actor'),
    )

    expect(decoded.operations).toEqual([
      expect.objectContaining({ operationId: 'op-foreign-mandate', authority: 'foreign', record: null }),
    ])
    expect(decoded.diagnostics).toEqual([])
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

it('threads externalHistories through encodeRecord into projection', () => {
  const record = {
    repository: 'acme/app',
    target: 'acme/app#42',
    version: 1 as const,
    recordId: 'event-external',
    runId: 'run-1',
    operationId: 'op-external',
    inputs: [] as string[],
    kind: 'epic-event' as const,
    payload: { outcome: 'verified' },
  }
  const source = {
    scope: githubScope('acme/app', 42),
    expectedAuthor: 'automation',
    stopAuthor: null,
    complete: true,
    comments: [] as [],
    diagnostics: [] as [],
  }
  const foreign = decodeHistory({ ...source, scope: githubScope('acme/app', 7), comments: [] })
  expect(encodeRecord(record, source, null, [foreign]).ok).toBe(true)
})

it('publishes a binding with an authentic external mandate despite a foreign copy', () => {
  const mandate = issueMandate(githubScope('acme/app', 7))
  const binding = bindingRecord(mandate)
  const source = { ...historyFrom(''), comments: [] }
  const mandateSource = { ...historyFrom(wire(mandate)), scope: githubScope('acme/app', 7) }
  const foreignSource = { ...historyFrom(wire(mandate), 'foreign'), scope: githubScope('acme/app', 7) }
  const authentic = decodeHistory(mandateSource)
  const foreign = decodeHistory(foreignSource)
  const noisy = { ...authentic, operations: [...authentic.operations, ...foreign.operations] }
  expect(foreign.operations).toEqual(expect.arrayContaining([expect.objectContaining({ authority: 'foreign' })]))
  expect(encodeRecord(binding, source, null, [noisy])).toMatchObject({ ok: true })
  expect(encodeRecord(binding, source, null, [{ ...authentic, operations: foreign.operations }])).toMatchObject({
    ok: false,
  })
  const editedSource = {
    ...mandateSource,
    comments: mandateSource.comments.map((comment) => ({ ...comment, updatedAt: '2026-10-21T00:00:01Z' })),
  }
  expect(encodeRecord(binding, source, null, [decodeHistory(editedSource)])).toMatchObject({ ok: false })
  expect(encodeRecord(binding, source, null, [{ ...authentic, operations: [] }])).toMatchObject({ ok: false })
})

describe('composed workflow history and landing binding readback', () => {
  it('composes PR and linked issue histories for a cold read', async () => {
    const issueBody = framed('epic-event', 'op-issue', 'event-issue')
    const prBody = framed('epic-event', 'op-pr', 'event-pr')
    const result = await readComposedWorkflowHistory([githubScope('acme/app', 42), githubScope('acme/app', 7)], {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => {
          const path = args[1] ?? ''
          if (path.includes('/issues/42/comments')) return JSON.stringify([nativeComment(1, prBody)])
          if (path.includes('/issues/7/comments'))
            return JSON.stringify([nativeComment(2, issueBody.replaceAll('acme/app#42', 'acme/app#7'))])
          return undefined
        },
      ]),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected composed history')
    expect(result.histories).toHaveLength(2)
    expect(result.histories.map((entry) => entry.source.scope.target)).toEqual(['acme/app#42', 'acme/app#7'])
  })

  it('ignores a foreign partial frame that reuses a trusted operation identity', async () => {
    const trusted = framed('epic-event', 'op-pr', 'event-pr')
    const foreign =
      '<!-- omp-build-record v=1 kind=epic-event id=event-pr operationId=op-pr part=1/2 data=e30 -->\n# Foreign'
    const result = await readComposedWorkflowHistory([githubScope('acme/app', 42)], {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) =>
          String(args[1] ?? '').includes('/issues/42/comments')
            ? JSON.stringify([nativeComment(1, trusted), { ...nativeComment(2, foreign), user: { login: 'foreign' } }])
            : undefined,
      ]),
    })

    expect(result).toMatchObject({ ok: true, records: [expect.objectContaining({ recordId: 'event-pr' })] })
    if (!result.ok) throw new Error('expected composed history')
    expect(result.histories[0]?.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationId: 'op-pr', authority: 'foreign', record: null, status: 'incomplete' }),
      ]),
    )
  })

  it('selects the authentic binding despite foreign claims and identity collisions', async () => {
    const mandate = issueMandate(githubScope('acme/app', 7))
    const binding = bindingRecord(mandate)
    const foreignCollision = framed('workflow-binding', binding.operationId, binding.recordId)
    const foreignOther = framed('workflow-binding', 'op-foreign', 'binding-foreign')
    const result = await readWorkflowBinding(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => {
          const path = String(args[1] ?? '')
          if (path.includes('/issues/42/comments'))
            return JSON.stringify([
              nativeComment(1, wire(binding)),
              { ...nativeComment(2, foreignCollision), user: { login: 'foreign' } },
              { ...nativeComment(3, foreignOther), user: { login: 'foreign' } },
            ])
          if (path.includes('/issues/7/comments')) return JSON.stringify([nativeComment(4, wire(mandate))])
          return undefined
        },
      ]),
    })
    expect(result).toMatchObject({ ok: true, value: { binding: { recordId: binding.recordId } } })
    if (!result.ok) throw new Error('expected binding')
    expect(result.value.histories.flatMap((history) => history.operations)).toEqual(
      expect.arrayContaining([expect.objectContaining({ authority: 'foreign', operationId: binding.operationId })]),
    )
  })

  it('treats foreign-only binding claims as absent while retaining them in history', async () => {
    const result = await readWorkflowBinding(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) =>
          String(args[1] ?? '').includes('/issues/42/comments')
            ? JSON.stringify([
                {
                  ...nativeComment(1, framed('workflow-binding', 'op-foreign', 'binding-foreign')),
                  user: { login: 'foreign' },
                },
              ])
            : undefined,
      ]),
    })
    expect(result).toMatchObject({ ok: false, reason: 'absent' })
  })

  it('refuses composed history when a scope comment page is unreadable', async () => {
    const refused = await readComposedWorkflowHistory([githubScope('acme/app', 42)], {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([(args) => (String(args[1] ?? '').includes('/comments') ? '{"not":"an-array"}' : undefined)]),
    })
    expect(refused).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('keeps a non-default base and does not invent a link from closing-keyword text', async () => {
    const stagingView = () => prView({ baseRefName: 'staging', body: 'Closes #7\n\nstaging-train feature PR' })
    const emptyClosing = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefName: 'feat/7-work',
            baseRefName: 'staging',
            headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            baseRefOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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

  it('refuses divergent accounted parent mandates without reading either parent chain', async () => {
    const firstParent = issueMandate(
      githubScope('acme/app', 3),
      'parent-1',
      issueMandate(githubScope('acme/app', 4), 'grandparent-1'),
    )
    const secondParent = {
      ...issueMandate(
        githubScope('acme/app', 3),
        'parent-1',
        issueMandate(githubScope('acme/app', 5), 'alternate-grandparent-1'),
      ),
      operationId: 'op-parent-alternate',
    }
    const mandate = issueMandate(githubScope('acme/app', 7), 'mandate-1', firstParent)
    const binding = bindingRecord(mandate)
    const commentPages: Record<string, string> = {
      '42': JSON.stringify([nativeComment(1, wire(binding))]),
      '7': JSON.stringify([nativeComment(2, wire(mandate))]),
      '3': JSON.stringify([nativeComment(3, wire(firstParent)), nativeComment(4, wire(secondParent))]),
      '4': JSON.stringify([]),
      '5': JSON.stringify([]),
    }
    const calls: string[][] = []
    const result = await readWorkflowBinding(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: async (_cwd, args) => {
        calls.push(args)
        if (args[0] === 'pr' && args[1] === 'view') return prView()
        const issue = String(args[1] ?? '').match(/\/issues\/(\d+)\/comments/)?.[1]
        const response = issue === undefined ? undefined : commentPages[issue]
        if (response !== undefined) return response
        throw new Error(`unexpected gh args: ${args.join(' ')}`)
      },
    })
    expect(result).toMatchObject({ ok: false, reason: 'incomplete' })
    expect(calls.some((args) => /\/issues\/[45]\/comments/.test(String(args[1] ?? '')))).toBe(false)
  })

  it('follows a confirmed workflow-binding and ignores tracker parentage', async () => {
    const mandate = issueMandate(githubScope('acme/app', 7))
    const binding = bindingRecord(mandate)
    const result = await readLandingFacts(githubScope('acme/app', 42), {
      cwd: '/fixture',
      readAuthor: 'automation',
      gh: fakeGh([
        (args) => (args[0] === 'pr' && args[1] === 'view' ? prView() : undefined),
        (args) => {
          if (!args.includes('graphql')) return undefined
          if (!args.some((arg) => arg.includes('subIssues(first: 100, after:')))
            return JSON.stringify({ data: { repository: { issue: { number: 7, parent: { number: 3 } } } } })
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  number: 7,
                  title: 'Save selection',
                  body: 'live strict spec',
                  updatedAt: '2026-10-27T12:00:00Z',
                  state: 'OPEN',
                  stateReason: null,
                  repository: { nameWithOwner: 'acme/app' },
                  parent: null,
                  labels: { nodes: [{ name: 'size:S' }], pageInfo: { hasNextPage: false, endCursor: null } },
                  subIssues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                  blockedBy: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
                },
              },
            },
          })
        },
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
    expect(result.observed).toEqual({
      head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      baseTip: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
    expect(result.uwGraph).toMatchObject({
      status: 'complete',
      root: githubScope('acme/app', 7),
      nodes: [expect.objectContaining({ raw: expect.objectContaining({ body: 'live strict spec' }) })],
    })
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
  it('preserves a graph read failure as a named incomplete graph fact', async () => {
    const mandate = issueMandate(githubScope('acme/app', 7))
    const binding = bindingRecord(mandate)
    const facts = await readLandingFacts(githubScope('acme/app', 42), {
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
    expect(facts).toMatchObject({ ok: true, uwGraph: { status: 'incomplete' } })
  })

  it('reuses the authentic published operation despite a foreign incomplete identity copy', async () => {
    const record = {
      repository: 'acme/app',
      target: 'acme/app#42',
      version: 1 as const,
      recordId: 'event-retry',
      runId: 'run-1',
      operationId: 'op-retry',
      inputs: [] as string[],
      kind: 'epic-event' as const,
      payload: { outcome: 'verified' },
    }
    const partial =
      '<!-- omp-build-record v=1 kind=epic-event id=event-retry operationId=op-retry part=1/2 data=e30 -->'
    const empty = decodeHistory({ ...historyFrom(''), comments: [] })
    let posts = 0
    const publish = (login: string) =>
      publishConfirmedWorkflowRecord(
        record,
        empty,
        {
          cwd: '/fixture',
          readAuthor: 'automation',
          writerLogin: 'automation',
          gh: fakeGh([
            (args) => {
              if (args.includes('POST')) {
                posts++
                throw new Error('unexpected publication')
              }
              if (String(args[1] ?? '').includes('/comments'))
                return JSON.stringify([
                  nativeComment(1, wire(record)),
                  { ...nativeComment(2, partial), user: { login } },
                ])
              return undefined
            },
          ]),
        },
        null,
      )
    expect(await publish('foreign')).toMatchObject({ status: 'confirmed', operation: { authority: 'accounted' } })
    expect(await publish('automation')).toMatchObject({ status: 'refused' })
    expect(posts).toBe(0)
  })

  it('never treats uncertain publication as a confirmed workflow checkpoint', async () => {
    const record = {
      repository: 'acme/app',
      target: 'acme/app#42',
      version: 1 as const,
      recordId: 'event-uncertain',
      runId: 'run-1',
      operationId: 'op-uncertain',
      inputs: [] as string[],
      kind: 'epic-event' as const,
      payload: { outcome: 'verified' },
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
            if (args[0] === 'api' && String(args[1] ?? '').includes('/comments') && !args.includes('--method'))
              return '[]'
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
