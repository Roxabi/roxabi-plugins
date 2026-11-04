import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { assessCauseDispositions, resolveCauseActionInputs } from '../../engine/cause-disposition.ts'
import { causeAdjudicationProposalSchema } from '../../engine/cause-disposition-schema.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { resolveOwnSpecEffective } from '../../engine/spec-effective.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import { recordsOf } from '../../engine/workflow-control.ts'
import { authenticatedReview } from '../../testing/cause-input-fixture.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { readAuthenticatedCause } from '../uw-cause-read.ts'
import type { UwRead, UwReadPort } from '../uw-contract.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const ref = (record: Extract<CanonicalRecord, { kind: 'cause-disposition' }>) => ({
  scope: { repository: record.repository, target: record.target },
  recordId: record.recordId,
  kind: record.kind,
})
function must<T>(
  result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string; message: string }[] },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

it('reads the final sister disposition after two authenticated sequential adjudications, but not its stale predecessor', async () => {
  const fixtures = roxabiWorkflowFixtures()
  const { projection } = roxabiRecordFixtures()
  const { graph, context: fixtureContext } = authenticatedReview()
  const uw = fixtureContext.original
  const mandate = fixtures.featureMandate(uw, { recordId: 'mandate-42', body: 'Save the selected region' })
  let own = fixtures.historyFrom([mandate])
  const sourceRecords = recordsOf(graph.history).filter((record) => record.kind !== 'review')
  const source = encodeCriterionRecords(sourceRecords, graph.history.source.scope, projection, 'operator', [
    own,
  ]).history
  const accepted = resolveAcceptedSpec(mandate, [own, source])
  if (!accepted.ok) throw new Error(`Fixture accepted Spec unavailable: ${accepted.reason}`)
  const context = { original: uw, effective: must(resolveOwnSpecEffective(accepted.spec)) }
  const decision = recordsOf(source).find(
    (record) => record.kind === 'decision' && record.recordId === graph.decision.recordId,
  )
  if (decision?.kind !== 'decision') throw new Error('Encoded review decision is missing')
  const actionInputs = must(resolveCauseActionInputs({ decision, history: source, context }))
  const citation = actionInputs.flatMap((input) => input.manifest.repositoryReferences)[0]
  if (!citation) throw new Error('Fixture repository evidence is missing')

  const append = (record: CanonicalRecord) => {
    own = encodeCriterionRecords([record], uw, projection, 'operator', [source], own).history
  }
  const assessment = (operations: Extract<CanonicalRecord, { kind: 'cause-operation' }>[]) =>
    must(
      assessCauseDispositions({
        context,
        source: { kind: 'decision', decision },
        histories: [own, source],
        adjudications: operations,
      }),
    ).outcomes.find((item) => item.subject.kind === 'cause')
  const disposition = (id: string, payload: NonNullable<ReturnType<typeof assessment>>) => {
    const record = must(
      buildRecord({
        version: 1,
        ...uw,
        recordId: id,
        runId: 'sequential-run',
        operationId: `write-${id}`,
        kind: 'cause-disposition',
        payload,
      }),
    )
    if (record.kind !== 'cause-disposition') throw new Error('Expected disposition')
    return record
  }
  const firstPayload = assessment([])
  if (firstPayload?.outcome.state !== 'pending-blocking') throw new Error('Expected initial pending cause')
  const first = disposition('pending-initial', firstPayload)
  append(first)

  const supported = (value: boolean) => ({
    state: 'supported' as const,
    value,
    reason: 'The pinned source supports this assessment',
    references: [citation],
  })
  const missing = { state: 'missing' as const, value: null, reason: 'Urgency needs a further decision', references: [] }
  const transition = (
    pending: typeof first,
    id: string,
    judgment: {
      necessary: ReturnType<typeof supported>
      urgent: ReturnType<typeof supported> | typeof missing
      tooLarge: ReturnType<typeof supported>
    },
  ) => {
    const proposal = causeAdjudicationProposalSchema.parse({
      format: 'omp-build-cause-adjudication-proposal/1',
      operationId: `adjudicate-${id}`,
      operation: 'adjudicate-cause',
      uw,
      pending: ref(pending),
      pendingDigest: digest(pending),
      rejectedFindingIds: [],
      judgment,
      reason: 'The selected source motivates this judgment',
      references: [citation],
    })
    const proposalDigest = digest(proposal)
    const operation = must(
      buildRecord({
        version: 1,
        ...uw,
        recordId: `operation-${id}`,
        runId: 'sequential-run',
        operationId: `write-operation-${id}`,
        kind: 'cause-operation',
        payload: {
          format: 'omp-build-cause-operation/1',
          proposal,
          proposalDigest,
          confirmation: {
            route: 'omp-native-command',
            operationId: proposal.operationId,
            proposalDigest,
            confirmedAt: '2026-10-27T12:00:00.000Z',
          },
        },
      }),
    )
    if (operation.kind !== 'cause-operation') throw new Error('Expected adjudication operation')
    append(operation)
    // Selecting exactly this operation works on both sides of the reader fix;
    // the reader must not mistake the consumed ancestor for a competing intent.
    const payload = assessment([operation])
    if (!payload || payload.previous?.recordId !== pending.recordId) throw new Error('Successor was not assessed')
    const next = disposition(`disposition-${id}`, payload)
    append(next)
    return { operation, next }
  }
  const one = transition(first, 'one', { necessary: supported(true), urgent: missing, tooLarge: supported(true) })
  expect(one.next.payload.outcome.state).toBe('pending-blocking')
  const two = transition(one.next, 'two', {
    necessary: supported(true),
    urgent: supported(true),
    tooLarge: supported(true),
  })
  expect(two.next.payload.outcome).toMatchObject({ state: 'final', disposition: 'sister-blocking', blocking: true })

  const histories = new Map<string, DecodedHistory>([
    [uw.target, own],
    [source.source.scope.target, source],
  ])
  const github = {
    cwd: '/fixture',
    readAuthor: 'operator',
    gh: async (_cwd: string, args: string[]) => {
      const match = /^repos\/acme\/app\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] ?? '')
      if (args[0] !== 'api' || !match) throw new Error(`Unexpected GH read: ${JSON.stringify(args)}`)
      const history = histories.get(`acme/app#${match[1]}`)
      if (!history) throw new Error(`Unexpected scope: ${match[1]}`)
      const page = Number(match[2])
      return JSON.stringify(
        history.source.comments.slice((page - 1) * 100, page * 100).map((comment, index) => ({
          id: (page - 1) * 100 + index + 1,
          body: comment.body,
          user: { login: comment.author },
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        })),
      )
    },
  }
  // The port supplies the real resolved accepted Spec; the cause reader itself
  // re-reads and authenticates every canonical record through the GH transport.
  const reader: UwReadPort = {
    readUw: async () => ({ accepted: { status: 'accepted', value: accepted.spec } }) as UwRead,
  }
  const read = await readAuthenticatedCause(ref(two.next), reader, github)
  expect(read.disposition).toEqual(two.next)
  expect(read.context).toEqual(context)
  const loadedOwn = read.histories.find((history) => history.source.scope.target === uw.target)
  expect(loadedOwn && recordsOf(loadedOwn).filter((record) => record.kind === 'cause-operation')).toEqual([
    one.operation,
    two.operation,
  ])
  await expect(readAuthenticatedCause(ref(one.next), reader, github)).rejects.toThrow('cause-disposition-stale')
})
