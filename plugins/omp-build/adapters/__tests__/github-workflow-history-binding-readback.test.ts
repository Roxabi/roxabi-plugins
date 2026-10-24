import { describe, expect, it } from 'vitest'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { decodeHistory, encodeRecord } from '../github/history-codec.ts'
import { githubScope } from '../github/transport.ts'
import { readLinkedIssueAssociation } from '../github-workflow/associations.ts'
import { publishConfirmedWorkflowRecord, readLandingFacts } from '../github-workflow/binding.ts'
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
  const foreign = decodeHistory({ ...source, scope: githubScope('acme/app', 7), comments: [] })
  expect(encodeRecord(record, source, null, [foreign]).ok).toBe(true)
})

describe('composed workflow history and landing binding readback', () => {
  it('composes PR and linked issue histories for a cold read', async () => {
    const issueBody = framed('proof', 'op-issue', 'proof-issue')
    const prBody = framed('proof', 'op-pr', 'proof-pr')
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
            ? JSON.stringify({ data: { repository: { issue: { number: 7, parent: { number: 3 } } } } })
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
    expect(result.observed).toEqual({
      head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      baseTip: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    })
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
