import { describe, expect, it } from 'vitest'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { AcceptedChildCommitment } from '../engine/workflow-mandate-schema.ts'
import { fixturePreparedAction } from '../testing/action-input-fixtures.ts'
import { contribution } from '../testing/record-decisions.ts'
import { history } from '../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { executeCorrection } from './correction-plan-execution.ts'
import { reconstructFixCheckpoint } from './fix-checkpoint-state.ts'
import type { FixRecord, FixTarget, PreparedFix } from './fix-contract.ts'
import { publishFixIntake } from './fix-contributions-native.ts'
import { assessFalsification, type CauseAdmission, type CorrectionCause } from './fix-domain'
import { matchesRequiredFeatureMandate } from './fix-mandate-authority.ts'
import type { FixMandateView } from './fix-mandate-types.ts'

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
  judgment: {
    necessary: { state: 'missing', value: null, reason: 'fixture', references: [] },
    urgent: { state: 'missing', value: null, reason: 'fixture', references: [] },
    tooLarge: { state: 'missing', value: null, reason: 'fixture', references: [] },
  },
  proposedDisposition: null,
}

function openTarget(): FixTarget {
  return {
    repository: 'Acme/app',
    target: 'Acme/app#42',
    number: 42,
    kind: 'pull-request',
    state: 'open',
    candidateGitSHA: 'a'.repeat(40),
    baseGitSHA: 'a'.repeat(40),
  }
}

describe('fix correction safety', () => {
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
        originalSpec: {
          uw: { repository: 'Acme/app', target: 'Acme/app#42' },
          version: 'a'.repeat(64),
          sourceAccepted: {
            scope: { repository: 'Acme/app', target: 'Acme/app#42' },
            kind: 'mandate',
            recordId: 'mandate',
          },
        },
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

  it('requires a matching leaf mandate in the authenticated accepted topology', () => {
    const scope = { repository: 'Acme/app', target: 'Acme/app#42' }
    const childScope = { repository: 'Acme/app', target: 'Acme/app#43' }
    const { featureMandate } = roxabiWorkflowFixtures()
    const record = featureMandate(scope, { recordId: 'feature-mandate' })
    const child = featureMandate(childScope, { recordId: 'child-mandate' })
    const mandate: FixMandateView = {
      recordId: record.recordId,
      role: record.payload.role,
      storedLanding: false,
      repository: record.repository,
      target: record.target,
      ownSpec: record.payload.ownSpec,
      tier: record.payload.tier,
      children: record.payload.children,
      parent: null,
      antecedent: null,
    }
    const required = { scope, recordId: mandate.recordId, kind: 'mandate' } satisfies {
      scope: typeof scope
      recordId: string
      kind: 'mandate'
    }
    const source = { scope, recordId: mandate.recordId, kind: 'mandate' } satisfies ExternalRecordRef
    const accepted = (children: AcceptedChildCommitment[]): AcceptedOwnSpec => ({
      ref: { uw: scope, version: record.payload.ownSpec.version, sourceAccepted: source },
      snapshot: record.payload.ownSpec.snapshot,
      tier: record.payload.tier,
      children,
      chain: [{ kind: 'mandate', source, version: record.payload.ownSpec.version }],
      sourceRefs: [source],
    })
    const parentChildren = [
      {
        scope: childScope,
        specVersion: child.payload.ownSpec.version,
        snapshot: child.payload.ownSpec.snapshot,
        tier: child.payload.tier,
      },
    ] satisfies AcceptedChildCommitment[]

    expect(matchesRequiredFeatureMandate(required, { ...mandate, role: 'epic' }, accepted([]))).toBe(true)
    expect(matchesRequiredFeatureMandate(required, mandate, accepted(parentChildren))).toBe(false)
    expect(matchesRequiredFeatureMandate(required, { ...mandate, role: 'fix-only' }, accepted([]))).toBe(false)
    expect(
      matchesRequiredFeatureMandate(
        { ...required, scope: { ...required.scope, target: 'Acme/app#99' } },
        mandate,
        accepted([]),
      ),
    ).toBe(false)
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

  it('retains an unusable required native result before refusing correction intake', async () => {
    const records: FixRecord[] = []
    const batch = {
      operationId: 'operation-1',
      tasks: {
        context: 'correction intake',
        tasks: [
          {
            name: 'slot-1',
            agent: 'R-adversarial',
            task: 'inspect',
            solutionSpace: 'bounded finding intake',
            action: fixturePreparedAction('slot-1'),
          },
        ],
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
        causeContext: {} as PreparedFix['causeContext'],
        subject: { kind: 'standalone-pr', pullRequest: { repository: 'Acme/app', target: 'Acme/app#42' } },
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
        tasks: [
          {
            name: 'slot-1',
            agent: 'R-adversarial',
            task: 'inspect',
            solutionSpace: 'bounded finding intake',
            action: fixturePreparedAction('slot-1'),
          },
        ],
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
        causeContext: {} as PreparedFix['causeContext'],
        subject: { kind: 'standalone-pr', pullRequest: { repository: 'Acme/app', target: 'Acme/app#42' } },
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

  it('withdraws an optional falsification failure without spending a retry', async () => {
    const admission: Extract<CauseAdmission, { status: 'selected' }> = {
      status: 'selected',
      required: false,
      cause: { ...requiredCause, id: 'RC-2', findingIds: ['finding-2'] },
    }
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
