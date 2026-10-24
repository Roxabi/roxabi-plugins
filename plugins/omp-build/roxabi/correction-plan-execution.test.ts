import { describe, expect, it } from 'vitest'
import type { Json } from '../dist/contracts.js'
import type { CorrectionEffectResult, CorrectionExecution, FalsificationFact } from './correction-execution-contract'
import { executeCorrectionPlan } from './correction-plan'
import { executeCorrection } from './correction-plan-execution'
import { assessFalsification, type CauseAdmission, type CorrectionCause, orderSelectedCauses } from './fix-domain'

const sha = 'a'.repeat(40)
const requiredCause: CorrectionCause = {
  id: 'RC-1',
  title: 'boundary rejects malformed input',
  mechanism: 'untrusted input reaches the consumer',
  fix: 'validate input at the boundary',
  failure: 'malformed input reaches the consumer',
  restored: 'malformed input is rejected',
  paths: ['src/consumer.ts:10'],
  proof: 'consumer rejects malformed input',
  findingIds: ['finding-blocking'],
  authorization: 'required',
  admission: { safePlan: true },
}
const selectedRequired: Extract<CauseAdmission, { status: 'selected' }> = {
  status: 'selected',
  cause: requiredCause,
  required: true,
}
function failed(diagnostics: string[], kind: 'retryable' | 'terminal' = 'retryable') {
  return { ok: false as const, kind, diagnostics }
}
function applied(raw: Json = { applied: true }) {
  return { ok: true as const, value: { commitSHAs: [sha], raw, contributionIds: ['contribution-apply'] } }
}
function fact(proofFailedIntendedScenario: boolean): FalsificationFact {
  return {
    guardId: 'guard-1',
    guard: 'boundary',
    intendedScenario: requiredCause.failure,
    removedProductionGuard: true,
    proofFailedIntendedScenario,
    proofToolCallId: 'call-1',
    proofUnavailableReason: null,
  }
}
function passingProof(): CorrectionEffectResult<{
  facts: FalsificationFact[]
  raw: Json
  contributionIds: string[]
  skippedReason?: string
}> {
  return {
    ok: true,
    value: {
      facts: [fact(true)],
      raw: { proof: 'failed when guard removed' },
      contributionIds: ['contribution-falsify-pass'],
    },
  }
}
function baseExecutor(overrides: Partial<CorrectionExecution>): CorrectionExecution {
  return {
    apply: async () => applied(),
    falsify: async () => passingProof(),
    revert: async () => ({ ok: true, value: { reverted: [sha], revertSHA: sha, contributionIds: [] } }),
    revalidateRequiredPaths: async () => ({ ok: true, value: { checked: [], contributionIds: [] } }),
    head: async () => ({ ok: true, value: sha }),
    push: async () => ({ ok: true, value: { head: sha, raw: { pushed: true }, contributionIds: [] } }),
    ...overrides,
  }
}

describe('correction plan execution', () => {
  it('keeps retained admissions after ordering selected parents before execution', () => {
    const retained: CauseAdmission = {
      status: 'retained',
      cause: { ...requiredCause, id: 'RC-2', findingIds: ['finding-optional'] },
      diagnostics: ['member-unusable:finding-optional'],
    }
    expect(
      orderSelectedCauses([retained, selectedRequired]).map((admission) => [admission.cause.id, admission.status]),
    ).toEqual([
      ['RC-1', 'selected'],
      ['RC-2', 'retained'],
    ])
  })
  it('fails on a known tautological guard even when another guard is unavailable', () => {
    expect(
      assessFalsification(
        [
          { guard: 'boundary', removedProductionGuard: true, proofFailedIntendedScenario: false },
          { guard: 'secondary', removedProductionGuard: false, proofFailedIntendedScenario: false, inconclusive: true },
        ],
        'secondary proof unavailable',
      ),
    ).toMatchObject({ result: 'fail' })
  })
  it('keeps three apply attempts separate from the second falsification round', async () => {
    const appliedAttempts: number[] = []
    let falsifications = 0
    const outcome = await executeCorrection(
      selectedRequired,
      baseExecutor({
        apply: async (_cause, attempt) => {
          appliedAttempts.push(attempt)
          return appliedAttempts.length < 3
            ? failed([`ordinary-red-${attempt}`])
            : applied({ call: appliedAttempts.length })
        },
        falsify: async () => {
          falsifications += 1
          return falsifications === 1
            ? {
                ok: true as const,
                value: {
                  facts: [fact(false)],
                  raw: { proof: 'tautological' },
                  contributionIds: ['contribution-falsify-fail'],
                },
              }
            : passingProof()
        },
      }),
    )
    expect(appliedAttempts).toEqual([1, 2, 3, 1])
    expect(falsifications).toBe(2)
    expect(outcome).toMatchObject({ outcome: 'applied', attempt: 2, falsification: { result: 'pass' } })
    expect(outcome.applyAttempts.map((entry) => [entry.round, entry.attempt, entry.result])).toEqual([
      [1, 1, 'failed'],
      [1, 2, 'failed'],
      [1, 3, 'applied'],
      [2, 1, 'applied'],
    ])
    expect(outcome.raw).toMatchObject({
      falsificationAttempts: [
        { round: 1, result: 'fail', raw: { proof: 'tautological' } },
        { round: 2, result: 'pass', raw: { proof: 'failed when guard removed' } },
      ],
    })
    expect(outcome.sourceContributionIds).toEqual([
      'contribution-apply',
      'contribution-falsify-fail',
      'contribution-falsify-pass',
    ])
  })
  it('stops immediately on a terminal native safety result', async () => {
    const calls: string[] = []
    const outcome = await executeCorrection(
      selectedRequired,
      baseExecutor({
        apply: async () => {
          calls.push('apply')
          return failed(['native-apply-git-state-unverified'], 'terminal')
        },
        falsify: async () => {
          calls.push('falsify')
          return passingProof()
        },
      }),
    )
    expect(outcome).toMatchObject({ outcome: 'failed', terminalFailure: true, attempt: 1, falsification: null })
    expect(outcome.execution).toEqual({ causeId: 'RC-1', falsificationRound: 1, attempted: true })
    expect(outcome.raw).toMatchObject({ effectsCleanup: 'unproven' })
    expect(calls).toEqual(['apply'])
  })
  it('retains a public terminal diagnostic only for typed pre-effect mandate refusal', async () => {
    const paused = await executeCorrectionPlan(
      [selectedRequired],
      baseExecutor({
        apply: async () => ({
          ok: false as const,
          kind: 'terminal' as const,
          diagnostics: ['fix-mandate-refused:paused'],
          preEffectRefusal: ['fix-mandate-refused:paused'],
        }),
      }),
    )
    expect(paused).toMatchObject({ ok: false, terminal: true, terminalDiagnostics: ['fix-mandate-refused:paused'] })
    expect(paused.outcomes[0]).toMatchObject({ commitSHAs: [], sourceContributionIds: [] })
    const unknownApplyState = await executeCorrectionPlan(
      [selectedRequired],
      baseExecutor({ apply: async () => failed(['fix-mandate-refused:paused'], 'terminal') }),
    )
    expect(unknownApplyState).toMatchObject({ ok: false, terminal: true, terminalDiagnostics: null })
    const afterEffect = await executeCorrectionPlan(
      [selectedRequired],
      baseExecutor({ falsify: async () => failed(['native-falsification-unusable'], 'terminal') }),
    )
    expect(afterEffect).toMatchObject({ ok: false, terminal: true, terminalDiagnostics: null })
    expect(afterEffect.outcomes[0]?.commitSHAs).toEqual([sha])
  })
  it('withholds an optional child when its required parent did not remain applied after its gate', async () => {
    const optionalCause: CorrectionCause = {
      ...requiredCause,
      id: 'RC-2',
      findingIds: ['finding-optional'],
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
    const calls: string[] = []
    const result = await executeCorrectionPlan(
      [selectedRequired, { status: 'selected', cause: optionalCause, required: false }],
      baseExecutor({
        apply: async (cause) => {
          calls.push(cause.id)
          return failed(['ordinary-red'])
        },
      }),
    )
    expect(calls).toEqual(['RC-1', 'RC-1', 'RC-1'])
    expect(result.outcomes.map((entry) => [entry.cause.id, entry.outcome])).toEqual([['RC-1', 'failed']])
    expect(result.retainedObligations).toContainEqual(
      expect.objectContaining({
        cause: expect.objectContaining({ id: 'RC-2' }),
        source: 'withheld',
        diagnostics: ['optional-parent-not-applied-after-gate'],
      }),
    )
    expect(result).toMatchObject({ ok: true, terminal: false })
  })
  it('reverts before revalidating required paths when optional falsification fails', async () => {
    const optional: Extract<CauseAdmission, { status: 'selected' }> = {
      status: 'selected',
      required: false,
      cause: {
        ...requiredCause,
        id: 'RC-2',
        findingIds: ['finding-optional'],
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
    }
    const effects: string[] = []
    const revalidated: string[][] = []
    const outcome = await executeCorrection(
      optional,
      baseExecutor({
        falsify: async () => ({
          ok: true,
          value: {
            facts: [fact(false)],
            raw: { proof: 'tautological' },
            contributionIds: ['contribution-falsify-fail'],
          },
        }),
        revert: async () => {
          effects.push('revert')
          return {
            ok: true,
            value: {
              reverted: [sha],
              revertSHA: sha,
              contributionIds: ['contribution-revert'],
            },
          }
        },
        revalidateRequiredPaths: async (causes) => {
          effects.push('revalidate')
          revalidated.push(causes.map((cause) => cause.id))
          return failed(['required-proof-red'], 'terminal')
        },
      }),
      [requiredCause],
    )
    expect(revalidated).toEqual([['RC-1']])
    expect(effects).toEqual(['revert', 'revalidate'])
    expect(outcome).toMatchObject({ outcome: 'failed', terminalFailure: true })
  })
  it('does not retry optional apply failure and revalidates required correction', async () => {
    const optional: Extract<CauseAdmission, { status: 'selected' }> = {
      status: 'selected',
      required: false,
      cause: {
        ...requiredCause,
        id: 'RC-2',
        findingIds: ['finding-optional'],
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
    }
    const calls: string[] = []
    const outcome = await executeCorrection(
      optional,
      baseExecutor({
        apply: async () => {
          calls.push('apply')
          return failed(['ordinary-red'])
        },
        revalidateRequiredPaths: async (causes) => {
          calls.push(`revalidate:${causes.map((cause) => cause.id).join(',')}`)
          return { ok: true, value: { checked: [], contributionIds: [] } }
        },
      }),
      [requiredCause],
    )
    expect(calls).toEqual(['apply', 'revalidate:RC-1'])
    expect(outcome).toMatchObject({ outcome: 'failed', attempt: 1 })
  })
})
