import { describe, expect, it } from 'vitest'
import { validateDecisionBindings } from '../dist/contracts.js'
import { contribution } from '../testing/record-decisions.ts'
import { reviewGraph } from '../testing/record-graphs.ts'
import { history } from '../testing/record-history.ts'
import { executeCorrection } from './correction-policy'
import {
  type FixRecord,
  type FixTarget,
  type PreparedFix,
  prepareStandaloneFix,
  publishFixIntake,
  reconstructFixCheckpoint,
  runReviewBoundFixWorkflow,
} from './fix'
import { admitCorrectionCauses, assessFalsification, type CorrectionCause, type FixFinding } from './fix-domain'

const blocking: FixFinding = { id: 'finding-1', label: 'issue(blocking)', usable: true }
const optional: FixFinding = { id: 'finding-2', label: 'suggestion', usable: true }
const requiredCause: CorrectionCause = {
  id: 'RC-1',
  title: 'guard missing',
  mechanism: 'input is not rejected',
  fix: 'validate the input at the boundary',
  failure: 'invalid input reaches the consumer',
  restored: 'invalid input is rejected',
  paths: ['src/consumer.ts:10'],
  proof: 'consumer rejects invalid input',
  findingIds: ['finding-1'],
  authorization: 'required',
  admission: { safePlan: true },
}

function openTarget(): FixTarget {
  return {
    repository: 'Acme/app',
    target: 'Acme/app#42',
    number: 42,
    kind: 'pull-request',
    state: 'open',
    candidateGitSHA: 'a'.repeat(40),
  }
}

describe('fix correction safety', () => {
  it('admits an accepted candidate required cause without inheriting a baseline label', () => {
    const neighbor: CorrectionCause = {
      ...requiredCause,
      id: 'RC-2',
      findingIds: ['finding-2'],

      authorization: { optionalNeighborOf: 'RC-1' },
      admission: {
        currentDefectMechanism: true,
        requiredBoundary: true,
        preservesPromise: true,
        noDependency: true,
        callerCompatibility: true,
        targetedProof: true,
        separable: true,
      },
    }
    const admissions = admitCorrectionCauses(
      { version: 'evidence-v1', acceptanceRef: 'acceptance-1' },
      [requiredCause, neighbor],
      [{ ...blocking, label: 'suggestion' }, optional],
    )

    expect(admissions).toMatchObject([
      { status: 'selected', required: true },
      { status: 'selected', required: false },
    ])
  })

  it('allows only the exact confirmed live request to reach its first native dispatch', () => {
    const evidence = contribution({
      id: 'ci-evidence',
      inventoryId: null,
      content: 'operator-request',
      rawAttempts: [
        {
          attemptIndex: 0,
          data: null,
          raw: { candidateGitSHA: 'a'.repeat(40) },
          partialText: null,
        },
      ],
    })
    const request: Extract<FixRecord, { kind: 'fix-request' }> = {
      ...evidence,
      recordId: 'ci-request',
      operationId: 'op-ci-request',
      inputs: [evidence.recordId],
      kind: 'fix-request',
      payload: {
        requestContributionId: evidence.recordId,
        existingReviewId: null,
        scope: 'correct the attributed CI failure',
        landing: false,
      },
    }
    const confirmed = history([evidence, request])

    const cold = reconstructFixCheckpoint(confirmed)
    expect(cold).toMatchObject({
      status: 'blocked',
      reason: 'unresolved-effect',
      startedRequestIds: [request.recordId],
    })
    expect(reconstructFixCheckpoint(confirmed, request)).toEqual({
      status: 'live-owned',
      requestId: request.recordId,
    })
    const mutated = reconstructFixCheckpoint(confirmed, {
      ...request,
      payload: { ...request.payload, scope: 'unowned request' },
    })
    expect(mutated).toMatchObject({
      status: 'blocked',
      reason: 'unresolved-effect',
      startedRequestIds: [request.recordId],
    })
  })

  it('requires every removed production guard to fail the intended scenario', () => {
    expect(
      assessFalsification([
        { guard: 'validateUser', removedProductionGuard: true, proofFailedIntendedScenario: true },
        { guard: 'validateToken', removedProductionGuard: true, proofFailedIntendedScenario: false },
      ]),
    ).toMatchObject({ result: 'fail' })
    expect(
      assessFalsification([{ guard: 'validateUser', removedProductionGuard: true, proofFailedIntendedScenario: true }]),
    ).toMatchObject({ result: 'pass' })
  })

  it('refuses a closed target before publishing an operator contribution', async () => {
    const records: FixRecord[] = []
    const result = await prepareStandaloneFix(
      {
        cwd: '/worktree',
        reference: '#42',
        rawOperatorRequest: { request: 'fix it' },
        scope: 'src/auth only',
        policy: { version: 'baseline' },
        identity: {
          runId: 'run-1',
          operationId: 'operation-1',
          nextRecordId: (kind) => `${kind}-1`,
        },
        publishBinding: {
          pushUrl: 'https://github.com/Acme/app.git',
          publicationRepository: 'Acme/app',
          localBranch: 'fix/auth',
          destinationRef: 'refs/heads/fix/auth',
          localHead: 'a'.repeat(40),
          expectedRemoteSHA: 'a'.repeat(40),
          defaultBranch: 'main',
          observed: {},
        },
        nativeTasks: [
          {
            name: 'slot-1',
            agent: 'R-adversarial',
            task: 'inspect correction scope',
            solutionSpace: 'correction evidence only',
          },
        ],
      },
      {
        resolveExplicit: async () => ({ ...openTarget(), state: 'closed' }),
        resolveContext: async () => null,
      },
      {
        publish: async (item) => {
          records.push(item)
          return { ok: true, value: undefined }
        },
      },
    )

    expect(result).toEqual({ ok: false, diagnostics: ['fix-target-closed'] })
    expect(records).toEqual([])
  })

  it('uses baseline policy by default for a bounded standalone correction', async () => {
    const records: FixRecord[] = []
    let sequence = 0
    const result = await prepareStandaloneFix(
      {
        cwd: '/worktree',
        reference: '#42',
        rawOperatorRequest: { request: 'fix it' },
        scope: 'src/auth only',
        identity: {
          runId: 'run-1',
          operationId: 'operation-1',
          nextRecordId: (kind) => `${kind}-${++sequence}`,
        },
        publishBinding: {
          pushUrl: 'https://github.com/Acme/app.git',
          publicationRepository: 'Acme/app',
          localBranch: 'fix/auth',
          destinationRef: 'refs/heads/fix/auth',
          localHead: 'a'.repeat(40),
          expectedRemoteSHA: 'a'.repeat(40),
          defaultBranch: 'main',
          observed: {},
        },
        nativeTasks: [
          {
            name: 'slot-1',
            agent: 'R-review-fix-intake',
            task: 'inspect correction scope',
            solutionSpace: 'correction evidence only',
          },
        ],
      },
      {
        resolveExplicit: async () => openTarget(),
        resolveContext: async () => null,
      },
      {
        publish: async (item) => {
          records.push(item)
          return { ok: true, value: undefined }
        },
      },
      {
        nextReviewStep: async () => ({ action: 'fix' }),
      },
    )

    expect(result.ok).toBe(true)
    const inventory = records.find((record) => record.kind === 'review-attempt')
    if (inventory?.kind !== 'review-attempt') throw new Error('expected correction inventory')
    expect(inventory.payload).toMatchObject({ purpose: 'correction', policy: { version: 'baseline' } })
    const source = records.find((record) => record.kind === 'contribution')
    if (source?.kind !== 'contribution') throw new Error('expected operator contribution')
    expect(source.payload).toMatchObject({
      structured: null,
      rawAttempts: [
        { raw: { operatorRequest: { request: 'fix it' }, publishBinding: { publicationRepository: 'Acme/app' } } },
      ],
    })
    expect(records.map((record) => record.kind)).toEqual(['contribution', 'fix-request', 'review-attempt'])
  })

  it('retains an unusable required native result before refusing correction intake', async () => {
    const records: FixRecord[] = []
    const batch = {
      operationId: 'operation-1',
      tasks: {
        context: 'correction intake',
        tasks: [{ name: 'slot-1', agent: 'R-adversarial', task: 'inspect', solutionSpace: 'bounded finding intake' }],
      },
    }
    const intake = await publishFixIntake(
      {
        target: openTarget(),
        requestId: 'request-1',
        inventoryId: 'inventory-1',
        sourceContributionId: 'source-1',
        policy: { version: 'baseline' },
        cwd: '/repo',
        publishBinding: {
          pushUrl: 'https://github.com/Acme/app.git',
          publicationRepository: 'Acme/app',
          localBranch: 'fix/auth',
          destinationRef: 'refs/heads/fix/auth',
          localHead: 'a'.repeat(40),
          expectedRemoteSHA: 'a'.repeat(40),
          defaultBranch: 'main',
          observed: {},
        },
        debtFiling: { file: async () => ({ ok: false, diagnostics: ['not-used'] }) },
        batch,
      },
      {
        runId: 'run-1',
        operationId: 'operation-1',
        nextRecordId: (kind: FixRecord['kind']) => `${kind}-${records.length + 1}`,
      },
      {
        publish: async (item: FixRecord) => {
          records.push(item)
          return { ok: true, value: undefined }
        },
      },
      {
        batch,
        children: [
          {
            id: 'slot-1:2',
            expectedId: 'slot-1',
            submissions: [{ attemptIndex: 0, data: null, raw: { exitCode: 1, error: 'failed' }, partialText: null }],
            raw: { exitCode: 1, error: 'failed' },
            partialText: null,
            usable: false,
            reason: 'required-child-exit-code',
            structured: null,
            proofEvidence: null,
          },
        ],
        raw: { details: { results: [{ id: 'slot-1:2' }] } },
        complete: false,
      },
    )

    expect(intake).toMatchObject({ ok: true, value: { complete: false, diagnostics: ['native-intake-incomplete'] } })
    expect(records).toHaveLength(1)
    const contribution = records[0]
    if (contribution?.kind !== 'contribution') throw new Error('expected retained native contribution')
    expect(contribution.payload.rawAttempts).toEqual([
      {
        attemptIndex: 0,
        data: null,
        raw: { exitCode: 1, error: 'failed' },
        partialText: null,
      },
    ])
    expect(contribution.payload.host).toMatchObject({ slotId: 'slot-1', childId: 'slot-1:2' })
  })

  it('refuses missing or wrong logical child associations while retaining actual SDK identities', async () => {
    const records: FixRecord[] = []
    const batch = {
      operationId: 'operation-1',
      tasks: {
        context: 'correction intake',
        tasks: [{ name: 'slot-1', agent: 'R-adversarial', task: 'inspect', solutionSpace: 'bounded finding intake' }],
      },
    }
    const result = await publishFixIntake(
      {
        target: openTarget(),
        requestId: 'request-1',
        inventoryId: 'inventory-1',
        sourceContributionId: 'source-1',
        policy: { version: 'baseline' },
        cwd: '/repo',
        publishBinding: {
          pushUrl: 'https://github.com/Acme/app.git',
          publicationRepository: 'Acme/app',
          localBranch: 'fix/auth',
          destinationRef: 'refs/heads/fix/auth',
          localHead: 'a'.repeat(40),
          expectedRemoteSHA: 'a'.repeat(40),
          defaultBranch: 'main',
          observed: {},
        },
        debtFiling: { file: async () => ({ ok: false, diagnostics: ['not-used'] }) },
        batch,
      },
      {
        runId: 'run-1',
        operationId: 'operation-1',
        nextRecordId: (kind: FixRecord['kind']) => `${kind}-${records.length + 1}`,
      },
      {
        publish: async (item: FixRecord) => {
          records.push(item)
          return { ok: true, value: undefined }
        },
      },
      {
        batch,
        children: [
          {
            id: 'slot-1:2',
            expectedId: null,
            submissions: [],
            raw: { id: 'slot-1:2' },
            partialText: null,
            usable: false,
            reason: 'logical-association-missing',
            structured: null,
            proofEvidence: null,
          },
          {
            id: 'slot-1:3',
            expectedId: 'wrong-slot',
            submissions: [],
            raw: { id: 'slot-1:3' },
            partialText: null,
            usable: false,
            reason: 'logical-association-wrong',
            structured: null,
            proofEvidence: null,
          },
        ],
        raw: { details: { results: [{ id: 'slot-1:2' }, { id: 'slot-1:3' }] } },
        complete: true,
      },
    )
    expect(result).toMatchObject({
      ok: true,
      value: {
        complete: false,
        diagnostics: expect.arrayContaining([
          'native-intake-child-association-missing',
          'native-intake-slot-unknown:wrong-slot',
          'native-intake-slot-missing:slot-1',
        ]),
      },
    })
    const firstContribution = records[0]
    const secondContribution = records[1]
    if (firstContribution?.kind !== 'contribution' || secondContribution?.kind !== 'contribution')
      throw new Error('expected retained native contributions')
    expect(firstContribution.payload.host).toMatchObject({ slotId: null, childId: 'slot-1:2' })
    expect(secondContribution.payload.host).toMatchObject({ slotId: null, childId: 'slot-1:3' })
  })
  it('blocks correction effects when a structurally bound required native slot is invalid', async () => {
    const graph = reviewGraph({ prefix: 'fix-effect-admission' })
    const decision = {
      ...graph.decision,
      payload: {
        ...graph.decision.payload,
        judgment: {
          ...graph.decision.payload.judgment,
          causes: [{ ...requiredCause, findingIds: ['fix-effect-admission-finding-final'] }],
        },
      },
    }
    const synthesis = {
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        structured: decision.payload.judgment,
        rawAttempts: graph.synthesisContribution.payload.rawAttempts.map((attempt) => ({
          ...attempt,
          data: decision.payload.judgment,
        })),
      },
    }
    const invalidPanel = {
      ...graph.panel,
      payload: {
        ...graph.panel.payload,
        native: { completion: 'error' as const, strict: 'invalid' as const, raw: { reason: 'terminal-native-error' } },
        structured: null,
      },
    }
    const invalidHistory = history(
      graph.records.map((record) =>
        record.recordId === graph.decision.recordId
          ? decision
          : record.recordId === graph.synthesisContribution.recordId
            ? synthesis
            : record.recordId === graph.panel.recordId
              ? invalidPanel
              : record,
      ),
    )
    expect(validateDecisionBindings(decision, invalidHistory)).toMatchObject({ admissible: true })
    let activated = 0
    let published = 0
    const result = await runReviewBoundFixWorkflow(
      {} as PreparedFix,
      decision,
      {
        readHistory: async () => invalidHistory,
        native: {
          active: () => null,
          activate: () => {
            activated += 1
          },
          announce: async () => {},
          stopOwned: async () => {},
        },
        publisher: {
          publish: async () => {
            published += 1
            return { ok: true, value: undefined }
          },
        },
        runtime: {
          signal: new AbortController().signal,
          onBatch: () => {},
          onStarted: () => {},
        },
      },
      { runId: 'run-1', operationId: 'operation-1', nextRecordId: (kind) => `${kind}-1` },
    )
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.stringContaining('correction-execution-admission-invalid:')],
    })
    expect(activated).toBe(0)
    expect(published).toBe(0)
  })

  it('withdraws an optional falsification failure without spending a retry', async () => {
    const [admission] = admitCorrectionCauses(
      { version: 'evidence-v1', acceptanceRef: 'acceptance-1' },
      [
        {
          ...requiredCause,
          id: 'RC-2',
          findingIds: ['finding-2'],
          authorization: { optionalNeighborOf: 'RC-1' },
          admission: {
            currentDefectMechanism: true,
            requiredBoundary: true,
            preservesPromise: true,
            noDependency: true,
            callerCompatibility: true,
            targetedProof: true,
            separable: true,
          },
        },
        {
          ...requiredCause,
          findingIds: ['finding-1'],
        },
      ],
      [blocking, optional],
    ).filter((item) => item.status === 'selected' && item.cause.id === 'RC-2')
    if (admission?.status !== 'selected') throw new Error('test setup did not admit the optional neighbor')
    const attempts: number[] = []
    const outcome = await executeCorrection(admission, {
      apply: async (_cause, attempt) => {
        attempts.push(attempt)
        return { ok: true, value: { commitSHAs: ['b'.repeat(40)], raw: { applied: true }, contributionIds: [] } }
      },
      revert: async () => ({
        ok: true,
        value: { reverted: ['b'.repeat(40)], revertSHA: 'c'.repeat(40), contributionIds: [] },
      }),
      revalidateRequiredPaths: async () => ({ ok: true, value: { checked: [], contributionIds: [] } }),
      falsify: async () => ({
        ok: true,
        value: {
          facts: [
            {
              guardId: 'guard-1',
              guard: 'validate',
              intendedScenario: requiredCause.failure,
              removedProductionGuard: true,
              proofFailedIntendedScenario: false,
              proofToolCallId: 'proof-1',
              proofUnavailableReason: null,
            },
          ],
          raw: { proof: 'still-passed' },
          contributionIds: [],
        },
      }),
      head: async () => ({ ok: true, value: 'b'.repeat(40) }),
      push: async () => ({ ok: true, value: { head: 'b'.repeat(40), raw: {}, contributionIds: [] } }),
    })

    expect(attempts).toEqual([1])
    expect(outcome.outcome).toBe('withdrawn')
    expect(outcome.falsification?.result).toBe('fail')
  })
})
