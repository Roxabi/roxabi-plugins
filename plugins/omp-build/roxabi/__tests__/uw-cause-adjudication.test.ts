import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { causeAdjudicationProposalSchema, parseRecord } from '../../dist/contracts.js'
import type { RecordDraft } from '../../engine/record-construction.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { fixture } from '../../testing/uw-operations-fixture.ts'
import { createCauseAdjudication } from '../uw-cause-adjudication.ts'
import { createUwOperations } from '../uw-operations.ts'

// Authenticated reads, engine decisions and publication are simulated here; engine
// evidence and GitHub authority are tested separately at their actual boundaries.
const boundary = vi.hoisted(() => ({
  read: vi.fn(),
  validate: vi.fn(),
  assess: vi.fn(),
  publish: vi.fn(),
  histories: vi.fn(),
  bind: vi.fn(),
}))
vi.mock('../uw-cause-adjudication-read.ts', () => ({ readAdjudicationPending: boundary.read }))
vi.mock('../../dist/contracts.js', async (load) => {
  const actual = await load<typeof import('../../dist/contracts.js')>()
  return {
    ...actual,
    validateCauseAdjudication: boundary.validate,
    assessAdjudicationSuccessor: boundary.assess,
    buildRecord: (record: RecordDraft) =>
      record.kind === 'cause-operation' ? actual.buildRecord(record) : { ok: true, value: record },
    publishConfirmedWorkflowRecord: boundary.publish,
    readComposedWorkflowHistory: boundary.histories,
    bindExternalRef: boundary.bind,
  }
})
const uw = { repository: 'owner/repo', target: 'owner/repo#2' }
const pending = { scope: uw, recordId: 'pending-1', kind: 'cause-disposition' as const }
const decision = { scope: uw, recordId: 'decision-1', kind: 'decision' as const }
const history = decodeHistory({
  scope: uw,
  expectedAuthor: 'operator',
  stopAuthor: null,
  complete: true,
  comments: [],
  diagnostics: [],
})
const context = { authenticated: 'canonical-reader-context' }
const source = {
  ...uw,
  kind: 'cause-disposition',
  recordId: pending.recordId,
  payload: { outcome: { state: 'pending-blocking' }, subject: { kind: 'cause', decision } },
}
const request = {
  pending,
  rejectedFindingIds: [],
  judgment: null,
  reason: 'Evidence resolves the uncertainty',
  references: [],
}

function setup(options: { confirm?: boolean; changed?: boolean; invalid?: boolean; missingIntent?: boolean } = {}) {
  let calls = 0
  boundary.read.mockImplementation(async () => ({
    disposition: options.changed && ++calls > 1 ? { ...source, recordId: 'different' } : source,
    histories: [history],
    catalogues: fixtureHostReviewClassCatalogues(),
    context,
  }))
  boundary.validate.mockReturnValue(options.invalid ? [{ code: 'cause-evidence-invalid' }] : [])
  let intent: { kind: string; recordId: string } | null = null
  const kinds: string[] = []
  boundary.publish.mockImplementation(async (record: { kind: string; recordId: string }) => {
    kinds.push(record.kind)
    if (record.kind === 'cause-operation') intent = record
    return { status: 'confirmed' }
  })
  boundary.histories.mockImplementation(async () => ({
    ok: true,
    histories: [
      {
        ...history,
        operations:
          intent === null
            ? []
            : [{ kind: 'cause-operation', status: 'complete', authority: 'authority', record: intent }],
      },
    ],
  }))
  boundary.bind.mockImplementation((ref: { kind: string }) =>
    ref.kind === 'decision'
      ? { ok: true, value: { kind: 'decision' } }
      : options.missingIntent
        ? { ok: false }
        : { ok: true, value: intent },
  )
  boundary.assess.mockImplementation(() => ({
    ok: true,
    value: { previous: pending, adjudication: { recordId: intent?.recordId }, state: 'test-outcome' },
  }))
  const base = fixture({ confirm: options.confirm })
  const adjudicate = createUwOperations({
    ...base.ports,
    causeOperations: (backend) => ({
      ...base.ports.causeOperations(backend),
      adjudicateCause: createCauseAdjudication({
        reader: { readUw: vi.fn() } as never,
        github: {} as never,
        operator: base.ports.operator,
      }),
    }),
  }).adjudicateCause
  return { adjudicate, kinds }
}

beforeEach(() => vi.clearAllMocks())
describe('adjudication orchestration (simulated authenticated boundary)', () => {
  it('refuses invalid evidence before confirmation or publication', async () => {
    const test = setup({ invalid: true })
    expect((await test.adjudicate(request)).status).toBe('refused')
    expect(test.kinds).toEqual([])
    expect(boundary.validate).toHaveBeenCalledWith(
      expect.objectContaining({ pending: source, context, histories: [history] }),
    )
  })

  it.each([{ confirm: false }, { changed: true }])(
    'does not publish a declined or stale adjudication',
    async (options) => {
      const test = setup(options)
      expect((await test.adjudicate(request)).status).toBe('refused')
      expect(test.kinds).toEqual([])
    },
  )

  it('does not publish a successor when the exact intent cannot be rebound', async () => {
    const test = setup({ missingIntent: true })
    expect((await test.adjudicate(request)).status).toBe('partial')
    expect(test.kinds).toEqual(['cause-operation'])
    expect(boundary.assess).not.toHaveBeenCalled()
  })

  it('uses the authenticated context for assessment and publishes no criterion-success record', async () => {
    const test = setup()
    expect((await test.adjudicate(request)).status).toBe('adjudicated')
    expect(boundary.assess).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        pending: source,
        operation: expect.objectContaining({ kind: 'cause-operation' }),
      }),
    )
    expect(test.kinds).toEqual(['cause-operation', 'cause-disposition'])
    const intent = boundary.publish.mock.calls[0]?.[0]
    const canonical = causeAdjudicationProposalSchema.parse(intent.payload.proposal)
    expect(JSON.stringify(intent.payload.proposal)).toBe(JSON.stringify(canonical))
    expect(intent.payload.proposalDigest).toBe(createHash('sha256').update(JSON.stringify(canonical)).digest('hex'))
    const reread = parseRecord(JSON.parse(JSON.stringify(intent)))
    expect(reread.ok).toBe(true)
    if (!reread.ok || reread.value.kind !== 'cause-operation') throw new Error('Expected canonical operation')
    expect(reread.value.payload.proposalDigest).toBe(
      createHash('sha256').update(JSON.stringify(reread.value.payload.proposal)).digest('hex'),
    )
  })
})
