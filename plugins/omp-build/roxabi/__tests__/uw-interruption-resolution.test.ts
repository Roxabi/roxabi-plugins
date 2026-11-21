import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { appendRecords, pairOf } from '../../engine/__tests__/workflow-interruption-support.ts'
import { actionInputDigest } from '../../engine/action-input.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { failedCheckEvidenceDigest } from '../../engine/record-digests.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { ACTION_RECEIPT_FORMAT } from '../../engine/workflow-receipt-schema.ts'
import { acceptedActionInputs, observeFixtureNativeWorld } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import {
  nativeDecisionBody,
  nativeDecisionMandate,
} from '../../testing/workflow-decision-cases/support/native-decision-spec.ts'
import {
  authenticatedPlanFixtures,
  SCOPE,
  shippedMandate,
} from '../../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import {
  claimStartActivation,
  recordStartClosedBeforeAdmission,
  recordStartNotActivated,
} from '../feature-start-executions.ts'
import type { OperatorPort, ResolveInterruptionRequest } from '../uw-contract.ts'
import { createInstalledObservedUwReadPort } from '../uw-read-port.ts'

const publication = vi.hoisted(() => ({ publish: vi.fn() }))
vi.mock('../../dist/contracts.js', async (original) => ({
  ...(await original<typeof import('../../dist/contracts.js')>()),
  publishConfirmedWorkflowRecord: publication.publish,
}))

import { createUwInterruptionResolution } from '../uw-interruption-resolution.ts'

const fixtures = roxabiWorkflowFixtures()
const ref = (record: CanonicalRecord) => ({
  scope: { repository: record.repository, target: record.target },
  recordId: record.recordId,
  kind: record.kind,
})

async function world(proof = true) {
  const mandate = nativeDecisionMandate(shippedMandate())
  const base = fixtures.historyFrom([mandate])
  const authenticated = authenticatedPlanFixtures(mandate, [base])
  const [start, result] = pairOf(
    authenticated.workflow.planDraftRecords(mandate, `act-plan-${randomUUID()}`, authenticated.version),
  )
  const pauseRequest = fixtures.pauseRequested(mandate)
  const pause = fixtures.pauseConfirmed(mandate, pauseRequest)
  let history = appendRecords(base, [start, pauseRequest, pause])
  const observation = async () =>
    observeFixtureNativeWorld({
      root: SCOPE,
      nodes: [
        {
          scope: SCOPE,
          title: 'Save the selected region',
          body: nativeDecisionBody,
          updatedAt: '2026-10-21T12:00:00Z',
          labels: ['size:S'],
          parent: null,
          children: [],
          blockers: [],
          state: 'OPEN',
          stateReason: null,
        },
      ],
      histories: [history],
      pullRequests: [],
      commits: [],
      comparisons: [],
    })
  const reads: string[] = []
  let extra: DecodedHistory[] = []
  const reader = {
    async readUw(scope: typeof SCOPE) {
      reads.push(scope.target)
      const current = (await observation()).observation
      return createInstalledObservedUwReadPort({
        observation: { ...current, histories: [...current.histories, ...extra] },
      }).readUw(scope)
    },
  }
  const prompts: unknown[] = []
  let onConfirm = () => {}
  const operator: OperatorPort = {
    async executeConfirmed(prepared, action) {
      prompts.push(prepared)
      onConfirm()
      return {
        status: 'confirmed',
        value: await action({
          route: 'omp-native-command',
          operationId: prepared.proposal.operationId,
          proposalDigest: prepared.digest,
          confirmedAt: '2026-11-14T12:00:00.000Z',
        }),
      }
    },
  }
  const startRef = { ...ref(start), kind: 'action-receipt' as const }
  if (proof) recordStartNotActivated(startRef)
  const request = {
    mandate: { ...ref(mandate), kind: 'mandate' as const },
    start: startRef,
    async observe(candidate: Parameters<ResolveInterruptionRequest['observe']>[0]) {
      return { ok: true as const, value: { runtime: candidate.runtime } }
    },
  }
  return {
    request,
    prompts,
    reads,
    reader,
    operator,
    mandate,
    result,
    issue: () => history,
    setExtra: (value: DecodedHistory[]) => {
      extra = value
    },
    setBusy: () => {
      claimStartActivation(startRef, 'other')
    },
    setChanged: () => {
      onConfirm = () => {
        claimStartActivation(startRef, 'late')
      }
    },
    setOnConfirm: (f: () => void) => {
      onConfirm = f
    },
    append: (record: CanonicalRecord) => {
      history = appendRecords(history, [record])
    },
  }
}

beforeEach(() => publication.publish.mockReset())
describe('UW interruption resolution backend', () => {
  it.each(['settled', 'unobserved'] as const)(
    'refuses a direct UW request with forged %s executor observation and no process dispatch proof',
    async (kind) => {
      const w = await world(false)
      const resolve = createUwInterruptionResolution({
        reader: w.reader,
        operator: w.operator,
        github: { cwd: '/unused' },
      })
      const result = await resolve({
        ...w.request,
        async observe(candidate) {
          return { ok: true, value: { runtime: candidate.runtime, effects: { kind: 'none' }, executor: { kind } } }
        },
      })
      expect(result.status).toBe('refused')
      expect(w.prompts).toEqual([])
      expect(publication.publish).not.toHaveBeenCalled()
    },
  )
  it('resolves a matching activation closed before admission and authenticates its readback', async () => {
    const w = await world(false)
    expect(claimStartActivation(w.request.start, 'batch-closed')).toBe(true)
    recordStartClosedBeforeAdmission(w.request.start, 'batch-closed')
    publication.publish.mockImplementationOnce(async (record: CanonicalRecord) => {
      w.append(record)
      return { status: 'confirmed' }
    })
    const resolve = createUwInterruptionResolution({
      reader: w.reader,
      operator: w.operator,
      github: { cwd: '/unused' },
    })
    expect(await resolve(w.request)).toMatchObject({ status: 'resolved' })
    expect(w.prompts).toHaveLength(1)
    expect(publication.publish).toHaveBeenCalledOnce()
  })
  it('refuses known busy before a confirmation is offered', async () => {
    const w = await world()
    w.setBusy()
    const resolve = createUwInterruptionResolution({
      reader: w.reader,
      operator: w.operator,
      github: { cwd: '/unused' },
    })
    expect(await resolve(w.request)).toMatchObject({
      status: 'refused',
      diagnostics: [{ code: 'interruption-dispatch-unproven' }],
    })
    expect(w.prompts).toHaveLength(0)
    expect(publication.publish).not.toHaveBeenCalled()
  })
  it('refuses stale executor disposition after confirmation without publishing', async () => {
    const w = await world()
    w.setChanged()
    const resolve = createUwInterruptionResolution({
      reader: w.reader,
      operator: w.operator,
      github: { cwd: '/unused' },
    })
    expect(await resolve(w.request)).toMatchObject({ status: 'refused', diagnostics: [{ code: 'proposal-stale' }] })
    expect(w.prompts).toHaveLength(1)
    expect(publication.publish).not.toHaveBeenCalled()
  })
  it('refuses a late RESULT observed after confirmation', async () => {
    const w = await world()
    w.setOnConfirm(() => w.append(w.result))
    const resolve = createUwInterruptionResolution({
      reader: w.reader,
      operator: w.operator,
      github: { cwd: '/unused' },
    })
    expect(await resolve(w.request)).toMatchObject({ status: 'refused', diagnostics: [{ code: 'proposal-stale' }] })
    expect(publication.publish).not.toHaveBeenCalled()
  })
  it('publishes and authenticates an attribute-ci resolution in its PR scope while reading the mandate UW', async () => {
    const w = await world()
    const pr = { repository: SCOPE.repository, target: `${SCOPE.repository}#99` }
    const sha = 'b'.repeat(40)
    const failures = [{ name: 'test', source: 'ci', observationId: 'check-11', conclusion: 'FAILURE' }]
    const evidenceDigest = failedCheckEvidenceDigest({ candidateGitSHA: sha, scope: pr, failures })
    if (evidenceDigest === null) throw new Error('missing check digest')
    const exactInputs = { candidateGitSHA: sha, scope: pr, failedChecks: ['test'], evidenceDigest, failures }
    const base = acceptedActionInputs(w.mandate, 'attribute-ci')
    const manifest = {
      ...base.manifest,
      code: { ...base.manifest.code, base: sha, head: sha, referenceCommit: sha },
      operands: { action: 'attribute-ci' as const, exactInputs },
    }
    const built = buildRecord({
      ...pr,
      version: 1,
      recordId: 'ci-start',
      runId: 'ci-run',
      operationId: 'ci-start-op',
      kind: 'action-receipt',
      payload: {
        format: ACTION_RECEIPT_FORMAT,
        phase: 'start',
        action: 'attribute-ci',
        actionId: 'act-ci-1',
        mandate: w.request.mandate,
        exactInputs,
        inputs: { ...base, manifest, fingerprint: actionInputDigest(manifest) },
      },
    })
    if (!built.ok) throw new Error(JSON.stringify(built.diagnostics))
    recordStartNotActivated({ ...ref(built.value), kind: 'action-receipt' })
    let prHistory = fixtures.historyFrom([built.value], 'operator', 'operator', [w.issue()])
    w.setExtra([prHistory])
    publication.publish.mockImplementationOnce(async (record: CanonicalRecord) => {
      expect(record.target).toBe(pr.target)
      prHistory = appendRecords(prHistory, [record])
      w.setExtra([prHistory])
      return { status: 'confirmed' }
    })
    const resolve = createUwInterruptionResolution({
      reader: w.reader,
      operator: w.operator,
      github: { cwd: '/unused' },
    })
    const result = await resolve({ ...w.request, start: { ...ref(built.value), kind: 'action-receipt' } })
    expect(result).toMatchObject({
      status: 'resolved',
      resolution: { scope: pr, recordId: 'interruption-resolution-ci-start' },
    })
    expect(w.reads.every((scope) => scope === SCOPE.target)).toBe(true)
  })
  it('reports partial publication and failed authenticated readback honestly', async () => {
    const w = await world()
    const resolve = createUwInterruptionResolution({
      reader: w.reader,
      operator: w.operator,
      github: { cwd: '/unused' },
    })
    publication.publish.mockResolvedValueOnce({
      status: 'partial',
      diagnostics: [{ code: 'write-failed', message: 'uncertain write' }],
    })
    expect(await resolve(w.request)).toMatchObject({ status: 'partial', diagnostics: [{ code: 'write-failed' }] })
    publication.publish.mockResolvedValueOnce({ status: 'confirmed' })
    expect(await resolve(w.request)).toMatchObject({
      status: 'partial',
      diagnostics: [{ code: 'interruption-readback-unconfirmed' }],
    })
    expect(w.reads.every((scope) => scope === SCOPE.target)).toBe(true)
  })
})
