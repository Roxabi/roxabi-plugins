import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeIssueWritePlan } from '../../../issue-triage/skills/shared/domain/issue-write.ts'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { causeCreationProposalSchema, parseRecord } from '../../dist/contracts.js'
import type { RecordDraft } from '../../engine/record-construction.ts'
import { createInput, fixture } from '../../testing/uw-operations-fixture.ts'
import { createCauseCreation } from '../uw-cause-creation.ts'
import type { CauseEffectGuard } from '../uw-cause-guard.ts'
import { createUwOperations } from '../uw-operations.ts'

// These are orchestration tests with simulated authenticated histories and native writes.
// They do not establish GitHub authentication or native relation persistence.
const boundary = vi.hoisted(() => ({
  readCause: vi.fn(),
  readReport: vi.fn(),
  observeParent: vi.fn(),
  checkParent: vi.fn(),
  publish: vi.fn(),
  histories: vi.fn(),
  bind: vi.fn(),
  validate: vi.fn(),
}))
vi.mock('../uw-cause-read.ts', () => ({
  readAuthenticatedCause: boundary.readCause,
  readAuthenticatedReport: boundary.readReport,
}))
vi.mock('../uw-cause-parent.ts', () => ({
  observeCauseParent: boundary.observeParent,
  assertCauseParentUnchanged: boundary.checkParent,
}))
vi.mock('../../dist/contracts.js', async (load) => {
  const actual = await load<typeof import('../../dist/contracts.js')>()
  return {
    ...actual,
    buildRecord: (record: RecordDraft) =>
      record.kind === 'cause-operation' ? actual.buildRecord(record) : { ok: true, value: record },
    publishConfirmedWorkflowRecord: boundary.publish,
    readComposedWorkflowHistory: boundary.histories,
    bindExternalRef: boundary.bind,
    validateCauseDispositionRecords: boundary.validate,
  }
})

const original = { repository: 'owner/repo', target: 'owner/repo#2' }
const parent = { repository: 'owner/repo', target: 'owner/repo#1' }
const sister = { repository: 'owner/repo', target: 'owner/repo#3' }
const ref = { scope: original, recordId: 'disposition-1', kind: 'cause-disposition' as const }
const originalIssue = { repository: 'owner/repo', number: 2 }
const sisterIssue = { repository: 'owner/repo', number: 3 }
const parentObservation = {
  parent,
  nativeDigest: 'a'.repeat(64),
  historyDigest: 'b'.repeat(64),
  state: 'inactive',
  diagnostics: [],
}
const history = (scope: typeof original) =>
  decodeHistory({ scope, expectedAuthor: 'operator', stopAuthor: null, complete: true, comments: [], diagnostics: [] })

function setup(
  options: {
    confirm?: boolean
    stale?: boolean
    parentState?: 'active' | 'indeterminate'
    mismatch?: boolean
    uncertain?: boolean
    partial?: boolean
    blocking?: boolean
    intentMissing?: boolean
    parentChangesAfterCreate?: boolean
    incompletePriorIntent?: boolean
  } = {},
) {
  const source = {
    ...original,
    kind: 'cause-disposition',
    recordId: ref.recordId,
    payload: {
      origin: { uw: original },
      subject: {
        kind: 'cause',
        decision: { scope: original, recordId: 'decision-1', kind: 'decision' },
        cause: {
          id: 'cause-1',
          title: 'Repair the cause',
          mechanism: 'Mechanism',
          failure: 'Failure',
          fix: 'Fix',
          paths: ['src/'],
          restored: 'Restored',
          proof: 'Proof',
        },
      },
      outcome: { state: 'final', disposition: options.blocking ? 'sister-blocking' : 'sister-after' },
    },
  }
  const report = { ...source, payload: { ...source.payload, outcome: { state: 'final', disposition: 'out-of-scope' } } }
  const own = history(original)
  if (options.incompletePriorIntent)
    own.operations.push({
      operationId: 'prior',
      recordId: 'prior:intent',
      kind: 'cause-operation',
      status: 'incomplete',
      parts: [],
      record: null,
      claimedKinds: ['cause-operation'],
      authority: 'authority',
    })
  const createdHistory = history(sister)
  let sourceReads = 0
  boundary.readCause.mockImplementation(async () => ({
    disposition: options.stale && ++sourceReads > 1 ? { ...source, recordId: 'changed' } : source,
    histories: [own],
  }))
  boundary.readReport.mockResolvedValue({ record: report, histories: [own] })
  boundary.observeParent.mockResolvedValue({ ...parentObservation, state: options.parentState ?? 'inactive' })
  boundary.checkParent.mockImplementation(async (_parent, _reader, _github, created) => {
    if (options.parentChangesAfterCreate && created !== null) throw new Error('cause-parent-active')
  })
  boundary.validate.mockReturnValue([])
  const events: string[] = []
  let intent: { kind: string; recordId: string } | null = null
  boundary.publish.mockImplementation(async (record: { kind: string; recordId: string }) => {
    events.push(record.kind)
    if (record.kind === 'cause-operation') intent = record
    return { status: 'confirmed' }
  })
  boundary.histories.mockImplementation(async () => ({
    ok: true,
    histories: [
      {
        ...own,
        operations:
          intent === null || options.intentMissing
            ? []
            : [{ recordId: intent.recordId, record: intent, status: 'complete', authority: 'authority', parts: [] }],
      },
      createdHistory,
    ],
  }))
  let proposalDigest = ''
  let operationId = ''
  boundary.bind.mockImplementation((requested: { kind: string }) =>
    requested.kind === 'cause-operation'
      ? { ok: true, value: intent }
      : { ok: true, value: { kind: 'spec-identity', payload: { proposalDigest, confirmation: { operationId } } } },
  )
  let originalBlockers: (typeof originalIssue)[] = []
  let sisterBlockers: (typeof originalIssue)[] = []
  let sisterParent: typeof parent | null = parent
  const readUw = vi.fn(async (scope: typeof original) => ({
    uw: scope,
    histories: [history(scope)],
    graph: {
      status: 'complete',
      nodes: [
        {
          uw: scope,
          title: 'Title',
          raw: { body: 'Body' },
          updatedAt: 'now',
          labels: [],
          parent: scope.target === sister.target ? sisterParent : parent,
          children: [],
          blockers:
            scope.target === sister.target ? sisterBlockers.map(() => original) : originalBlockers.map(() => sister),
        },
      ],
    },
    identity: { ok: true, value: { head: { scope: sister, recordId: 'identity-1', kind: 'spec-identity' } } },
  }))
  const base = fixture({ confirm: options.confirm })
  const nativeCreate = vi.fn(async (plan: NativeIssueWritePlan, guard: CauseEffectGuard) => {
    await guard({ primitive: 'create', created: null })
    events.push('create')
    try {
      await guard({ primitive: 'add-child', created: sisterIssue })
    } catch {
      return { status: 'partial', issue: sisterIssue, completed: ['create'], diagnostics: [] }
    }
    if (options.uncertain)
      return {
        status: 'uncertain',
        completed: [],
        diagnostics: [{ code: 'create-uncertain', message: 'No trustworthy issue reference' }],
      }
    if (options.partial) return { status: 'partial', issue: sisterIssue, completed: ['create'], diagnostics: [] }
    sisterParent = options.mismatch ? null : plan.relations.parent == null ? null : parent
    sisterBlockers = [...plan.relations.addBlockers]
    return { status: 'written', observed: { issue: sisterIssue } }
  })
  const guardedWriter = (guard: CauseEffectGuard) => ({
    create: (plan: NativeIssueWritePlan) => nativeCreate(plan, guard),
    update: async () => {
      await guard({ primitive: 'add-blocker', created: sisterIssue })
      originalBlockers = [sisterIssue]
      events.push('relation')
      return { status: 'written' }
    },
  })
  const service = createUwOperations({
    ...base.ports,
    read: readUw as never,
    guardedWriter: guardedWriter as never,
    scopeOf: () => sister,
    publishIdentity: async ({ proposal }) => {
      proposalDigest = proposal.digest
      operationId = proposal.proposal.operationId
      return { status: 'confirmed' }
    },
    causeOperations: (backend) => ({
      ...base.ports.causeOperations(backend),
      ...createCauseCreation({
        reader: { readUw } as never,
        github: {} as never,
        operator: base.ports.operator,
        ...backend,
        guardedWriter: guardedWriter as never,
      }),
    }),
  })
  const sisterRequest = {
    disposition: ref,
    factors: createInput().factors,
    tierOverride: null,
    labels: { add: [], remove: [] },
  }
  return { service, sisterRequest, nativeCreate, events, readUw }
}

beforeEach(() => vi.clearAllMocks())

describe('cause creation orchestration (simulated boundaries)', () => {
  it('cancellation and stale source never create or publish intent', async () => {
    const cancelled = setup({ confirm: false })
    expect((await cancelled.service.createSister(cancelled.sisterRequest)).status).toBe('refused')
    expect(cancelled.nativeCreate).not.toHaveBeenCalled()
    expect(cancelled.events).toEqual([])
    const stale = setup({ stale: true })
    expect((await stale.service.createSister(stale.sisterRequest)).status).toBe('refused')
    expect(stale.nativeCreate).not.toHaveBeenCalled()
    expect(stale.events).toEqual([])
  })

  it.each(['active', 'indeterminate'] as const)(
    'refuses an %s parent before confirmation and create',
    async (parentState) => {
      const test = setup({ parentState })
      const result = await test.service.createSister(test.sisterRequest)
      expect(result.status).toBe('refused')
      expect(test.nativeCreate).not.toHaveBeenCalled()
      expect(test.events).toEqual([])
    },
  )

  it('does not retry when a previous creation intent remains incomplete', async () => {
    const test = setup({ incompletePriorIntent: true })
    expect((await test.service.createSister(test.sisterRequest)).status).toBe('refused')
    expect(test.nativeCreate).not.toHaveBeenCalled()
    expect(test.events).toEqual([])
  })

  it('holds the operation before create if the confirmed intent cannot be read back', async () => {
    const test = setup({ intentMissing: true })
    const result = await test.service.createSister(test.sisterRequest)
    expect(result.status).toBe('partial')
    expect(test.nativeCreate).not.toHaveBeenCalled()
    expect(test.events).toEqual(['cause-operation'])
  })

  it('holds a partial creation when the parent becomes active before a later effect', async () => {
    const test = setup({ parentChangesAfterCreate: true })
    const result = await test.service.createSister(test.sisterRequest)
    expect(result.status).toBe('partial')
    expect(test.events).toEqual(['cause-operation', 'create'])
  })

  it.each([false, true])(
    'frames a same-parent sister and publishes a receipt only after relation readback (blocking=%s)',
    async (blocking) => {
      const test = setup({ blocking })
      const result = await test.service.createSister(test.sisterRequest)
      expect(result.status).toBe('created')
      const framed = test.nativeCreate.mock.calls[0]?.[0]
      expect(framed?.relations.parent).toEqual({ repository: parent.repository, number: 1 })
      expect(framed?.relations.addBlockers).toEqual(blocking ? [] : [originalIssue])
      expect(test.events).toEqual(
        blocking
          ? ['cause-operation', 'create', 'relation', 'debt-receipt']
          : ['cause-operation', 'create', 'debt-receipt'],
      )
      expect(test.readUw).toHaveBeenCalledWith(sister)
      const intent = boundary.publish.mock.calls[0]?.[0]
      const canonical = causeCreationProposalSchema.parse(intent.payload.proposal)
      expect(JSON.stringify(intent.payload.proposal)).toBe(JSON.stringify(canonical))
      expect(intent.payload.proposalDigest).toBe(createHash('sha256').update(JSON.stringify(canonical)).digest('hex'))
      const reread = parseRecord(JSON.parse(JSON.stringify(intent)))
      expect(reread.ok).toBe(true)
      if (!reread.ok || reread.value.kind !== 'cause-operation') throw new Error('Expected canonical operation')
      expect(reread.value.payload.proposalDigest).toBe(
        createHash('sha256').update(JSON.stringify(reread.value.payload.proposal)).digest('hex'),
      )
    },
  )

  it('holds a created issue without a receipt when parent readback differs', async () => {
    const test = setup({ mismatch: true })
    const result = await test.service.createSister(test.sisterRequest)
    expect(result.status).toBe('partial')
    expect(test.events).toEqual(['cause-operation', 'create'])
  })

  it.each(['uncertain', 'partial'] as const)('preserves %s after intent without issuing a receipt', async (outcome) => {
    const test = setup({ [outcome]: true })
    const result = await test.service.createSister(test.sisterRequest)
    expect(result.status).toBe(outcome)
    expect(test.events).toEqual(['cause-operation', 'create'])
  })

  it('promotes a report with a promotion receipt, never a debt receipt', async () => {
    const test = setup()
    const initial = createInput()
    const create = {
      ...initial,
      repository: original.repository,
      normalization: [],
      draft: {
        ...initial.draft,
        criteria: [{ kind: 'new' as const, draftKey: 'promoted', statement: 'The promoted report is resolved' }],
      },
      writes: {
        labels: { add: [...initial.writes.labels.add], remove: [...initial.writes.labels.remove] },
        relations: {
          ...initial.writes.relations,
          addChildren: [...initial.writes.relations.addChildren],
          removeChildren: [...initial.writes.relations.removeChildren],
          addBlockers: [...initial.writes.relations.addBlockers],
          removeBlockers: [...initial.writes.relations.removeBlockers],
        },
      },
    }
    const result = await test.service.promoteReport({
      report: ref,
      create,
      reason: 'This report merits a separately scoped UW',
    })
    expect(result.status).toBe('created')
    expect(test.events).toEqual(['cause-operation', 'create', 'report-promotion'])
  })
})
