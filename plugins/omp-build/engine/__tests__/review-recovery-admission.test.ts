import { describe, expect, test } from 'vitest'
import { reviewRoot, TEST_INPUT, TEST_SCOPE } from '../../testing/record-builders.ts'
import { history, operation } from '../../testing/record-history.ts'
import { buildRecord, type RecordDraft } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { readReviewRecovery } from '../review-recovery.ts'
import { admitReviewReplacementInventory } from '../review-recovery-admission.ts'
import {
  buildReviewInterruptionRecord,
  buildReviewReplacementGrantRecord,
  buildReviewReplacementInventoryRecord,
  reviewReplacementInventoryRecordId,
} from '../review-recovery-records.ts'
import { summarizeReviews } from '../review-state.ts'
import { TAXONOMY } from './record-test-support.ts'
import { binding, mandate } from './workflow-test-support.ts'

type WorkflowBinding = Extract<CanonicalRecord, { kind: 'workflow-binding' }>

function freshBinding(id: string, mandated: Extract<CanonicalRecord, { kind: 'mandate' }>): WorkflowBinding {
  const built = buildRecord({
    version: 1,
    repository: TEST_SCOPE.repository,
    target: TEST_SCOPE.target,
    recordId: id,
    runId: 'recovery-run',
    operationId: `op-${id}`,
    kind: 'workflow-binding',
    payload: {
      branch: 'feature/bounded',
      base: 'main',
      mandate: { scope: TEST_SCOPE, recordId: mandated.recordId, kind: 'mandate' },
    },
  } satisfies RecordDraft)
  if (!built.ok || built.value.kind !== 'workflow-binding') throw new Error('test binding must be valid')
  return built.value
}

function recoveredChain() {
  const root = reviewRoot({ id: 'recovery-root', input: TEST_INPUT })
  const mandated = mandate()
  const historicalBinding = binding(mandated, TEST_SCOPE)
  if (historicalBinding.kind !== 'workflow-binding') throw new Error('test historical binding must be valid')
  const interruption = buildReviewInterruptionRecord({ root, historicalBinding, runId: 'recovery-run' })
  if (!interruption.ok) throw new Error('test terminal must be valid')
  const currentBinding = freshBinding('current-recovery-binding', mandated)
  const grant = buildReviewReplacementGrantRecord({
    root,
    disposition: interruption.value,
    binding: currentBinding,
    candidateGitSHA: '2222222222222222222222222222222222222222',
    digest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    runId: 'recovery-run',
  })
  if (!grant.ok) throw new Error('test grant must be valid')
  return { root, historicalBinding, interruption: interruption.value, currentBinding, grant: grant.value }
}

describe('review recovery admission', () => {
  test('keeps a neutral terminal disarmed and refuses unauthenticated terminal evidence', () => {
    const chain = recoveredChain()
    const terminalHistory = history([chain.root, chain.historicalBinding, chain.interruption])
    expect(readReviewRecovery(terminalHistory)).toMatchObject({
      ok: true,
      value: { normalProgression: 'stopped', replacementGrant: null },
    })
    expect(summarizeReviews(terminalHistory, TAXONOMY, null)).toMatchObject({ ok: false })

    const forged = {
      ...terminalHistory,
      operations: [
        operation(chain.root),
        operation(chain.historicalBinding),
        operation(chain.interruption, { parts: [{ ...operation(chain.interruption).parts[0], author: 'other-bot' }] }),
      ],
    }
    expect(readReviewRecovery(forged)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'unbound' })]),
    })
  })

  test('refuses partial and contradictory recovery publications instead of retrying around them', () => {
    const chain = recoveredChain()
    const records = [chain.root, chain.historicalBinding, chain.interruption, chain.currentBinding]
    const partial = {
      ...history(records),
      operations: [...history(records).operations, operation(chain.grant, { status: 'incomplete', record: null })],
    }
    expect(readReviewRecovery(partial)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'incomplete' })]),
    })

    const conflictingGrant = {
      ...chain.grant,
      payload: { ...chain.grant.payload, candidateGitSHA: '3'.repeat(40) },
    }
    expect(readReviewRecovery(history([...records, chain.grant, conflictingGrant]))).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'conflict' })]),
    })
  })
  test('only consumes a one-use grant with its exact candidate, input, binding, and deterministic identity', () => {
    const chain = recoveredChain()
    const grantedHistory = history([
      chain.root,
      chain.historicalBinding,
      chain.interruption,
      chain.currentBinding,
      chain.grant,
    ])
    const template = reviewRoot({
      id: 'caller-chosen-id-is-not-used',
      head: chain.grant.payload.candidateGitSHA,
      input: chain.grant.payload.input,
    })
    expect(
      admitReviewReplacementInventory({
        history: grantedHistory,
        template: { ...template, payload: { ...template.payload, input: 'c'.repeat(64) } },
        binding: chain.currentBinding,
      }),
    ).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'conflict' })]) })

    const admitted = admitReviewReplacementInventory({
      history: grantedHistory,
      template,
      binding: chain.currentBinding,
    })
    expect(admitted).toMatchObject({ ok: true, value: { recordId: chain.grant.recordId } })
    if (!admitted.ok) return
    const replacement = buildReviewReplacementInventoryRecord({
      grant: admitted.value,
      template,
      runId: 'recovery-run',
    })
    expect(replacement).toMatchObject({
      ok: true,
      value: { recordId: reviewReplacementInventoryRecordId(chain.grant.recordId) },
    })
    if (!replacement.ok) return
    expect(
      readReviewRecovery(
        history([...grantedHistory.operations.map((entry) => entry.record as CanonicalRecord), replacement.value]),
      ),
    ).toMatchObject({
      ok: true,
      value: { normalProgression: 'stopped', replacementGrant: null },
    })
  })
})
