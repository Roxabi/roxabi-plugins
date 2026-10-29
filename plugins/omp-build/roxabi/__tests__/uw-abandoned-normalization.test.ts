import { afterEach, describe, expect, it, vi } from 'vitest'
import { calculateTier } from '../../../issue-triage/skills/shared/domain/complexity.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { prepareSpecAllocation } from '../../engine/uw-identity.ts'
import { selectApplicableMandate } from '../../engine/workflow-mandate-admission.ts'
import type { NativeBatch, NativeBatchCallbacks, NativeBatchResult } from '../../omp/review-runtime/contracts.ts'
import { selectionNormalization } from '../feature-continuation-selection.ts'
import type { FeatureCommandHost } from '../feature-contract.ts'
import type { UwOperations, UwProposalInput, UwRead } from '../uw-contract.ts'
import { announceUwNormalization } from '../uw-normalization-host.ts'
import {
  bindHistoricalProjection,
  historicalProjection,
  writeSuccessorNormalization,
} from '../uw-normalization-internal.ts'
import { prepareExistingProposal, staleWrite } from '../uw-proposal-preparation.ts'
import { setup, statement, time, uw } from './uw-abandoned-normalization-support.ts'
import {
  isolateViewerToken,
  observationalGh,
  observationalGit,
  preparedNormalization,
  releaseViewerToken,
} from './uw-normalization-observation.ts'

async function normalizeExplicitSuccessor(
  subject: { operations: UwOperations; request: UwProposalInput; history: DecodedHistory },
  before: UwRead,
): Promise<void> {
  expect(await subject.operations.write(subject.request)).toMatchObject({ status: 'refused' })
  const selected = selectionNormalization(
    'new',
    {
      scope: uw,
      selection: selectApplicableMandate(subject.history),
    },
    before,
  )
  expect(selected?.kind).toBe('normalization')
  if (selected?.kind !== 'normalization') throw new Error('expected explicit successor normalization')
  vi.useFakeTimers()
  try {
    let callbacks: NativeBatchCallbacks | undefined
    let batch: NativeBatch | undefined
    const continued: unknown[] = []
    const delivered: unknown[] = []
    isolateViewerToken()
    const git = observationalGit()
    const gh = observationalGh()
    const host = {
      principal: false,
      uw: Object.assign(subject.operations, {
        prepareAction: async () => ({ ok: true, value: preparedNormalization(selected.request) }),
      }),
      featureContinuationInhibited: () => false,
      workflow: {
        continueFeature: async (input: unknown) => {
          continued.push(input)
          return { kind: 'terminal', reason: 'continued' }
        },
      },
      native: {
        activate: (value: NativeBatch, handlers: NativeBatchCallbacks) => {
          batch = value
          callbacks = handlers
        },
        announce: async () => undefined,
      },
      send: async () => undefined,
    } as unknown as FeatureCommandHost
    await announceUwNormalization({
      reference: uw.target,
      request: selected.request,
      original: { cwd: '/repo', reference: uw.target, control: 'new', principal: false, git, gh },
      host,
      deliver: async (result) => {
        delivered.push(result)
      },
    })
    const activeBatch = batch as NativeBatch | undefined
    const activeCallbacks = callbacks as NativeBatchCallbacks | undefined
    if (activeBatch === undefined || activeCallbacks === undefined)
      throw new Error('native normalization was not activated')
    const result = {
      batch: activeBatch,
      complete: true,
      children: [{ id: 'normalizer', usable: true, structured: {} }],
    } as unknown as NativeBatchResult
    activeCallbacks.onComplete(result, () => true)
    const settlement = activeCallbacks.onSettled?.(result, () => true)
    await vi.runAllTimersAsync()
    await settlement
    expect(continued).toEqual([expect.objectContaining({ control: 'new' })])
    expect(delivered).toEqual([expect.objectContaining({ kind: 'terminal' })])
  } finally {
    vi.useRealTimers()
  }
}

afterEach(() => releaseViewerToken())

describe('normalization after an authenticated abandoned mandate', () => {
  it('rejects changed or missing authenticated predecessor history after confirmation', async () => {
    const active = setup(false)
    const abandoned = setup(true)
    const prepared = await active.operations.prepare(active.request)
    if (!prepared.ok || prepared.value.proposal.expected === null) throw new Error('expected a prepared real proposal')
    const read = await abandoned.read(uw)
    const historical = historicalProjection(read)
    if (historical === undefined) throw new Error('expected authenticated historical projection')
    const proposal = prepareExistingProposal(
      abandoned.request,
      read,
      prepared.value.proposal.expected.observed,
      {
        prepareSpecAllocation,
        renderIssueSpecBody,
        calculateTier,
      },
      true,
    )
    if ('diagnostics' in proposal || proposal.proposal.expected === null)
      throw new Error('expected eligible successor proposal')
    const observed = proposal.proposal.expected.observed
    expect(staleWrite(proposal, read, observed)).toBe(false)
    const changed = { ...read }
    bindHistoricalProjection(changed, historical.accepted, 'changed-history')
    expect(staleWrite(proposal, changed, observed)).toBe(true)
    const changedPredecessor = structuredClone(historical.accepted)
    changedPredecessor.ref.sourceAccepted.recordId = 'different-mandate'
    bindHistoricalProjection(changed, changedPredecessor, historical.historyDigest)
    expect(staleWrite(proposal, changed, observed)).toBe(true)
    expect(staleWrite(proposal, { ...read }, observed)).toBe(true)
  })

  it('rejects mutation of the selected normalization request and consumes its capability', async () => {
    const subject = setup(true)
    const read = await subject.read(uw)
    const selected = selectionNormalization(
      'new',
      {
        scope: uw,
        selection: selectApplicableMandate(subject.history),
      },
      read,
    )
    if (selected?.kind !== 'normalization') throw new Error('expected explicit successor normalization')
    selected.request.title = 'changed after selection'
    expect(writeSuccessorNormalization(subject.operations, selected.request, subject.request)).toBeNull()
    expect(writeSuccessorNormalization(subject.operations, selected.request, subject.request)).toBeNull()
    expect(subject.counts()).toEqual({ confirmations: 0, patches: 0 })
  })

  it.each([
    ['active baseline', false],
    ['abandoned compatible /3 mandate', true],
  ])('prepares and confirms a conserved legacy normalization with %s', async (_label, abandoned) => {
    const subject = setup(abandoned)
    expect(subject.mandate.payload.format).toBe('omp-build-mandate/3')
    expect(subject.history.source.complete).toBe(true)
    expect(subject.history.operations).toHaveLength(abandoned ? 3 : 2)
    expect(
      subject.history.operations.every((entry) => entry.status === 'complete' && entry.authority !== 'foreign'),
    ).toBe(true)
    expect(subject.parsed.status).toBe('legacy')
    const before = await subject.read(uw)
    if (!abandoned) expect(before.accepted.status).toBe('accepted')
    if (abandoned && before.accepted.status === 'refused') {
      expect(before.accepted.diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'accepted-unavailable' })]),
      )
    }
    expect(before.identity.ok).toBe(true)
    if (!before.identity.ok) throw new Error('expected readable identity ledger')
    expect([...before.identity.value.retired]).toEqual([])
    expect(before.identity.value.allocations.has('C1')).toBe(true)
    if (!abandoned) {
      expect(await subject.operations.prepare(subject.request)).toMatchObject({ ok: true })
      expect(await subject.operations.write(subject.request)).toMatchObject({ status: 'written' })
    } else {
      await normalizeExplicitSuccessor(subject, before)
    }
    expect(subject.counts()).toEqual({ confirmations: 1, patches: 1 })
    const after = parseIssueSpecBody({ uw, raw: rawSource(uw.target, subject.body(), time) })
    expect(after.status).toBe('conformant')
    if (after.status !== 'conformant') throw new Error('expected normalized conformant Spec')
    expect(after.snapshot.spec.criteria).toEqual([{ id: 'C1', statement }])
  })
})
