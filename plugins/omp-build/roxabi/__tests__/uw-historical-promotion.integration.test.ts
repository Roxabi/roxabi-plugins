import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import type { Gh } from '../../adapters/github/types.ts'
import {
  assessCauseDispositions,
  buildRecord,
  createReviewClassCatalogues,
  readCauseDispositionHeads,
  recordsOf,
  reviewClassCatalogueRef,
} from '../../dist/contracts.js'
import { causeOriginalHistory, sisterRecords } from '../../testing/cause-input-fixture.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { acceptedPullRequestReviewGraph } from '../../testing/record-graphs.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { createInput, fixture } from '../../testing/uw-operations-fixture.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'

type NativeComment = { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }

function independentHold() {
  const origin = causeOriginalHistory()
  const originalMandate = recordsOf(origin).find((record) => record.kind === 'mandate')
  if (originalMandate?.kind !== 'mandate') throw new Error('expected original mandate')
  const otherPr = { repository: 'acme/app', target: 'acme/app#46' }
  const binding = roxabiWorkflowFixtures().workflowBinding(otherPr, originalMandate, 'feat/42-save', 'main')
  const other = acceptedPullRequestReviewGraph({
    mandate: originalMandate,
    binding,
    prefix: 'independent-hold',
    label: 'issue',
  })
  if (other.inputs.manifest.spec.kind !== 'accepted') throw new Error('expected accepted hold input')
  const assessed = assessCauseDispositions({
    context: { original: origin.source.scope, effective: other.inputs.manifest.spec.effective },
    source: { kind: 'decision', decision: other.decision },
    histories: [origin, other.history],
    catalogues: fixtureHostReviewClassCatalogues(),
    adjudications: [],
  })
  if (!assessed.ok) throw new Error(`independent hold assessment refused: ${JSON.stringify(assessed.diagnostics)}`)
  const pending = assessed.value.outcomes.find((item) => item.outcome.state === 'pending-blocking')
  if (!pending) throw new Error('expected independent pending hold')
  const hold = buildRecord({
    version: 1,
    ...origin.source.scope,
    recordId: 'independent-hold',
    runId: 'hold-run',
    operationId: 'independent-hold-op',
    kind: 'cause-disposition',
    payload: pending,
  })
  if (!hold.ok || hold.value.kind !== 'cause-disposition') throw new Error('invalid independent hold')
  const pinned = reviewClassCatalogueRef(other.inputs)
  if (!pinned.ok) throw new Error('expected pinned hold catalogue')
  const missingCatalogue = createReviewClassCatalogues([
    {
      ref: pinned.value,
      contents: { ok: false, diagnostics: [{ code: 'unreadable', message: 'Pinned catalogue unavailable' }] },
    },
  ])
  const currentHoldHistory = decodeHistory({
    ...origin.source,
    comments: [
      ...origin.source.comments,
      {
        locator: 'acme/app#42:independent-hold',
        nativeId: 'independent-hold',
        body: wire(hold.value),
        author: origin.source.expectedAuthor,
        createdAt: '2026-10-27T12:00:00Z',
        updatedAt: '2026-10-27T12:00:00Z',
      },
    ],
  })
  const completeHold = readCauseDispositionHeads({
    uw: origin.source.scope,
    histories: [currentHoldHistory, other.history],
    catalogues: fixtureHostReviewClassCatalogues(),
  })
  expect(completeHold.ok, JSON.stringify(completeHold)).toBe(true)
  const missingEvidence = readCauseDispositionHeads({
    uw: origin.source.scope,
    histories: [currentHoldHistory, other.history],
    catalogues: missingCatalogue,
  })
  expect(missingEvidence.ok).toBe(false)
  return hold
}

function historicalReport() {
  const held = sisterRecords().held
  if (held.kind !== 'cause-disposition') throw new Error('expected disposition')
  const built = buildRecord({
    version: 1,
    repository: held.repository,
    target: held.target,
    recordId: 'historical-report',
    runId: 'historic',
    operationId: 'historical-report-op',
    kind: 'cause-disposition',
    payload: {
      ...held.payload,
      outcome: { state: 'final', disposition: 'report', blocking: false, reason: 'Retained historical work' },
    },
  })
  if (!built.ok) throw new Error('report fixture invalid')
  return built.value
}

it.each(['inactive', 'active', 'indeterminate', 'active-after-create'] as const)(
  'uses the installed parent guard during promotion: %s',
  async (parentState) => {
    const hold = independentHold()
    const report = historicalReport()
    const comments = new Map<number, NativeComment[]>([
      [41, []],
      [42, [nativeComment(1, wire(report)), nativeComment(2, wire(hold.value))]],
      [43, []],
    ])
    const parentScope = { repository: 'acme/app', target: 'acme/app#41' }
    const mandate = roxabiWorkflowFixtures().featureMandate(parentScope, { recordId: 'parent-mandate' })
    const activateParent = () => comments.get(41)?.push(nativeComment(90, wire(mandate)))
    if (parentState === 'active' || parentState === 'indeterminate') activateParent()
    if (parentState === 'indeterminate') {
      const conflicting = roxabiWorkflowFixtures().featureMandate(parentScope, {
        recordId: 'parent-mandate-conflicting',
        operationId: 'parent-mandate-conflicting-op',
      })
      comments.get(41)?.push(nativeComment(91, wire(conflicting)))
    }
    const issues = new Map<number, { title: string; body: string; labels: string[]; parent: number | null }>([
      [41, { title: 'Parent', body: '', labels: [], parent: null }],
      [42, { title: 'Original', body: '', labels: [], parent: 41 }],
    ])
    let postId = 10
    let creates = 0
    let patches = 0
    const forbidden: string[] = []
    function handleComments(endpoint: string, args: string[], number: number): string {
      const list = comments.get(number)
      if (!list) {
        forbidden.push(endpoint)
        throw new Error('old PR unavailable')
      }
      if (!args.includes('POST')) return JSON.stringify(list)
      const body = args.find((arg) => arg.startsWith('body='))?.slice(5)
      if (body === undefined) throw new Error('missing comment body')
      const item = nativeComment(++postId, body)
      list.push(item)
      return JSON.stringify(item)
    }
    function handleGraph(args: string[]): string {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('addSubIssue')) {
        const child = issues.get(43)
        if (!child) throw new Error('created child missing')
        child.parent = 41
        return JSON.stringify({ data: { addSubIssue: {} } })
      }
      const number = Number(args.find((arg) => arg.startsWith('number='))?.slice(7))
      const issue = issues.get(number)
      if (!issue) throw new Error(`unavailable issue ${number}`)
      const node = (n: number) => ({ number: n, repository: { nameWithOwner: 'acme/app' } })
      const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
      return JSON.stringify({
        data: {
          repository: {
            issue: {
              number,
              title: issue.title,
              body: issue.body,
              updatedAt: '2026-10-27T12:00:00Z',
              state: 'OPEN',
              stateReason: null,
              repository: { nameWithOwner: 'acme/app' },
              parent: issue.parent === null ? null : node(issue.parent),
              labels: page(issue.labels.map((name) => ({ name }))),
              subIssues: page([...issues].filter(([, value]) => value.parent === number).map(([child]) => node(child))),
              blockedBy: page([]),
            },
          },
        },
      })
    }

    function handleLabels(args: string[]): string {
      const issue = issues.get(Number(args[2]))
      if (!issue) throw new Error('unknown issue')
      const index = args.indexOf('--add-label')
      if (index >= 0) issue.labels.push(...(args[index + 1] ?? '').split(','))
      return ''
    }

    function handlePatch(number: number, args: string[]): string {
      const issue = issues.get(number)
      if (!issue) throw new Error(`cannot patch unknown issue ${number}`)
      const fields = args.flatMap((arg, index) => (arg === '--raw-field' ? [args[index + 1] ?? ''] : []))
      if (fields.length === 0) throw new Error('empty issue patch')
      for (const field of fields) {
        if (field.startsWith('title=')) issue.title = field.slice(6)
        else if (field.startsWith('body=')) issue.body = field.slice(5)
        else throw new Error(`unexpected patch field ${field}`)
      }
      patches += 1
      return '{}'
    }

    function handleIssueApi(endpoint: string, args: string[]): string | null {
      if (endpoint.endsWith('/issues') && args.includes('POST')) {
        creates += 1
        if (parentState === 'active-after-create') activateParent()
        issues.set(43, {
          title: args.find((arg) => arg.startsWith('title='))?.slice(6) ?? '',
          body: args.find((arg) => arg.startsWith('body='))?.slice(5) ?? '',
          labels: [],
          parent: null,
        })
        return '43'
      }
      const issueMatch = /issues\/(\d+)$/.exec(endpoint)
      if (issueMatch && args.includes('PATCH')) return handlePatch(Number(issueMatch[1]), args)
      return issueMatch && args.includes('.node_id') ? `node-${issueMatch[1]}` : null
    }

    const gh: Gh = async (_cwd, args) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (args[0] === 'api' && args[1] === 'user') return 'automation'
      const commentMatch = /issues\/(\d+)\/comments/.exec(endpoint)
      if (commentMatch) return handleComments(endpoint, args, Number(commentMatch[1]))
      const issueApiResult = handleIssueApi(endpoint, args)
      if (issueApiResult !== null) return issueApiResult
      if (args[0] === 'issue' && args[1] === 'edit') return handleLabels(args)
      if (args[1] === 'graphql') return handleGraph(args)
      forbidden.push(args.join(' '))
      throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
    }
    let confirmations = 0
    const base = fixture({
      onConfirm: () => {
        confirmations += 1
      },
    })
    const operations = await createInstalledUwOperations({
      cwd: '/fixture',
      gh,
      readAuthor: 'automation',
      operator: base.ports.operator,
    })
    if (parentState === 'inactive') {
      const before = await operations.listReports(parentScope)
      expect(before.ok, JSON.stringify(before)).toBe(true)
      if (!before.ok) throw new Error('historical descendant report unavailable')
      expect(before.value.reports.map((item) => item.ref.recordId)).toContain('historical-report')
      expect(forbidden).toEqual([])
    }
    const initial = createInput()
    const create = {
      ...initial,
      repository: 'acme/app',
      normalization: [],
      draft: {
        ...initial.draft,
        criteria: [{ kind: 'new' as const, draftKey: 'promotion', statement: 'Resolve the promoted report' }],
      },
      writes: {
        labels: { add: [], remove: [] },
        relations: {
          parent: { repository: 'acme/app', number: 41 },
          addChildren: [],
          removeChildren: [],
          addBlockers: [],
          removeBlockers: [],
        },
      },
    }
    const result = await operations.promoteReport({
      report: {
        scope: { repository: report.repository, target: report.target },
        recordId: report.recordId,
        kind: 'cause-disposition',
      },
      create,
      reason: 'Promote the retained report into separately scoped work',
    })
    if (parentState === 'active' || parentState === 'indeterminate') {
      expect(result.status, JSON.stringify(result)).toBe('refused')
      expect(JSON.stringify(result)).toContain(`cause-parent-${parentState}`)
      expect(confirmations).toBe(0)
      expect(creates).toBe(0)
      expect(patches).toBe(0)
      expect(comments.get(42)?.some((item) => item.body.includes('kind=cause-operation'))).toBe(false)
    } else if (parentState === 'active-after-create') {
      expect(result.status, JSON.stringify(result)).toBe('partial')
      expect(JSON.stringify(result)).toContain('cause-parent-active')
      expect(confirmations).toBe(1)
      expect(creates).toBe(1)
      expect(issues.get(43)?.parent).toBeNull()
      expect(comments.get(42)?.some((item) => item.body.includes('kind=report-promotion'))).toBe(false)
    } else {
      expect(result.status, JSON.stringify(result)).toBe('created')
      expect(confirmations).toBe(1)
      expect(creates).toBe(1)
      expect(patches).toBe(1)
      expect(issues.get(43)?.parent).toBe(41)
      expect(comments.get(42)?.some((item) => item.body.includes('kind=report-promotion'))).toBe(true)
      expect(comments.get(43)?.some((item) => item.body.includes('kind=spec-identity'))).toBe(true)
      const listing = await operations.listReports({ repository: 'acme/app', target: 'acme/app#42' })
      expect(listing.ok, JSON.stringify(listing)).toBe(true)
      if (!listing.ok) throw new Error('promoted report listing refused')
      expect(listing.value.reports).toEqual([
        expect.objectContaining({
          ref: expect.objectContaining({ recordId: 'historical-report' }),
          promotion: expect.objectContaining({ kind: 'report-promotion' }),
        }),
      ])
      const ledger = decodeHistory({
        scope: { repository: report.repository, target: report.target },
        expectedAuthor: 'automation',
        stopAuthor: null,
        complete: true,
        diagnostics: [],
        comments: (comments.get(42) ?? []).map((item) => ({
          locator: `acme/app#42:${item.id}`,
          nativeId: String(item.id),
          body: item.body,
          author: item.user.login,
          createdAt: item.created_at,
          updatedAt: item.updated_at,
        })),
      })
      expect(recordsOf(ledger).find((record) => record.recordId === hold.value.recordId)).toEqual(hold.value)
      const current = readCauseDispositionHeads({
        uw: ledger.source.scope,
        histories: [ledger],
        catalogues: fixtureHostReviewClassCatalogues(),
      })
      if (!current.ok) expect(current.diagnostics.map((item) => item.code)).toContain('cause-source-unconfirmed')
      expect(current.ok).toBe(false)
      expect(forbidden).toEqual([])
    }
  },
)
