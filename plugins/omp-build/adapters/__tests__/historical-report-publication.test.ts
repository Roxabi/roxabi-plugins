import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { causeCreationProposalSchema } from '../../engine/cause-disposition-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { createPublicationContextResolver } from '../../roxabi/publication-context.ts'
import { fixtureCatalogueGhResponse } from '../../testing/action-input-fixtures.ts'
import { sisterRecords } from '../../testing/cause-input-fixture.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { publishConfirmedWorkflowRecord } from '../github-workflow/binding.ts'
import { comment, nativeComment, wire } from './github-workflow-support.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T => {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}

it('publishes a historical PR-sourced report promotion through the actual codec and publisher without reopening the PR', async () => {
  const fixture = sisterRecords()
  const held = fixture.held
  if (
    held.kind !== 'cause-disposition' ||
    fixture.operation.kind !== 'cause-operation' ||
    fixture.identity.kind !== 'spec-identity'
  )
    throw new Error('fixture kinds')
  const report = unwrap(
    buildRecord({
      version: 1,
      repository: held.repository,
      target: held.target,
      recordId: 'historical-report',
      runId: 'historical-run',
      operationId: 'historical-report-op',
      kind: 'cause-disposition',
      payload: {
        ...held.payload,
        outcome: { state: 'final', disposition: 'report', blocking: false, reason: 'Retain the historical report' },
      },
    }),
  )
  const scope = { repository: report.repository, target: report.target }
  const reportRef = { scope, recordId: report.recordId, kind: 'cause-disposition' as const }
  const originalProposal = fixture.operation.payload.proposal
  if (originalProposal.operation !== 'create') throw new Error('fixture proposal')
  const proposal = causeCreationProposalSchema.parse({
    ...originalProposal,
    operationId: 'promote-historical',
    creation: {
      kind: 'report-promotion',
      report: reportRef,
      reportDigest: digest(report),
      reason: 'Newly scoped work',
      parentObservation: null,
    },
  })
  const proposalDigest = digest(proposal)
  const confirmation = {
    route: 'omp-native-command' as const,
    operationId: proposal.operationId,
    proposalDigest,
    confirmedAt: '2026-10-27T12:00:00.000Z',
  }
  const intent = unwrap(
    buildRecord({
      version: 1,
      ...scope,
      recordId: 'promote-historical:intent',
      runId: 'promote-historical',
      operationId: 'promote-historical:intent',
      kind: 'cause-operation',
      payload: { format: 'omp-build-cause-operation/1', proposal, proposalDigest, confirmation },
    }),
  )
  const created = { repository: fixture.identity.repository, target: fixture.identity.target }
  const identity = unwrap(
    buildRecord({
      version: 1,
      ...created,
      recordId: 'created-identity',
      runId: 'promote-historical',
      operationId: proposal.operationId,
      kind: 'spec-identity',
      payload: {
        format: 'omp-build-spec-identity/1',
        event: 'allocate',
        predecessor: null,
        proposalDigest,
        confirmation,
        allocations: proposal.allocation.assignments,
      },
    }),
  )
  const receipt = unwrap(
    buildRecord({
      version: 1,
      ...scope,
      recordId: 'promote-historical:receipt',
      runId: 'promote-historical',
      operationId: 'promote-historical:receipt',
      kind: 'report-promotion',
      payload: {
        format: 'omp-build-report-promotion/1',
        report: reportRef,
        operation: { scope, recordId: intent.recordId, kind: 'cause-operation' },
        created,
        identity: { scope: created, recordId: identity.recordId, kind: 'spec-identity' },
      },
    }),
  )
  const source = {
    scope,
    expectedAuthor: 'automation',
    stopAuthor: null,
    complete: true,
    comments: [comment(wire(report), 'automation', '1')],
    diagnostics: [],
  }
  const identityHistory = decodeHistory({
    ...source,
    scope: created,
    comments: [comment(wire(identity), 'automation', '300')],
  })
  const comments = [nativeComment(1, wire(report))]
  let posts = 0
  const github = {
    cwd: '/fixture',
    readAuthor: 'automation',
    writerLogin: 'automation',
    gh: async (_cwd: string, args: string[]) => {
      const catalogue = fixtureCatalogueGhResponse(args)
      if (catalogue !== null) return catalogue
      if (args.includes('POST')) {
        const body = args.find((arg) => arg.startsWith('body='))
        if (!body) throw new Error('missing post body')
        const posted = nativeComment(100 + ++posts, body.slice(5))
        comments.push(posted)
        return JSON.stringify(posted)
      }
      if (String(args[1] ?? '').includes(`/issues/${created.target.split('#')[1]}/comments`))
        return JSON.stringify([nativeComment(300, wire(identity))])
      if (String(args[1] ?? '').includes(`/issues/${scope.target.split('#')[1]}/comments`))
        return JSON.stringify(comments)
      throw new Error(`old PR unavailable: ${args.join(' ')}`)
    },
  }
  const first = await publishConfirmedWorkflowRecord(intent, github, createPublicationContextResolver(github, null), [])
  expect(first.status).toBe('confirmed')
  const second = await publishConfirmedWorkflowRecord(receipt, github, createPublicationContextResolver(github, null), [
    identityHistory,
  ])
  expect(second.status).toBe('confirmed')
  expect(posts).toBeGreaterThanOrEqual(2)
})
