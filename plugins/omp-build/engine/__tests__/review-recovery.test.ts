import { describe, expect, test } from 'vitest'
import { fixtureReviewClassCatalogues, freshReviewInputs } from '../../testing/action-input-fixtures.ts'
import { reviewRoot, TEST_SCOPE } from '../../testing/record-builders.ts'
import { history, observedComment, operation } from '../../testing/record-history.ts'
import { buildRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Result } from '../result.ts'
import { readReviewRecovery } from '../review-recovery.ts'
import { summarizeReviews } from '../review-state.ts'
import { binding, mandate } from './workflow-test-support.ts'

describe('review recovery', () => {
  test('terminalizes an interrupted root without admitting an ordinary fresh start', () => {
    const root = reviewRoot({ id: 'interrupted-root' })
    const historicalMandate = mandate()
    const historicalBinding = binding(historicalMandate, TEST_SCOPE)
    const disposition: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'review-interruption-interrupted-root',
      runId: 'recovery-run',
      operationId: 'recovery-interruption-interrupted-root',
      kind: 'review-interruption',
      payload: {
        rootAttemptId: root.recordId,
        historicalBinding: {
          scope: { repository: historicalBinding.repository, target: historicalBinding.target },
          recordId: historicalBinding.recordId,
          kind: 'workflow-binding',
        },
      },
    } as never)

    expect(disposition).toMatchObject({ ok: true })
    if (!disposition.ok) return
    expect(disposition.value.inputs).toHaveLength(2)
    expect(disposition.value.inputs).toEqual(expect.arrayContaining([root.recordId, historicalBinding.recordId]))

    const recovered = readReviewRecovery(history([root, historicalBinding, disposition.value]))
    expect(recovered).toMatchObject({
      ok: true,
      value: { normalProgression: 'stopped', replacementGrant: null },
    })

    const ordinary = summarizeReviews(
      history([root, historicalBinding, disposition.value]),
      fixtureReviewClassCatalogues(),
      null,
    )
    expect(ordinary).toMatchObject({ ok: false })
    if (!ordinary.ok)
      expect(ordinary.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'incomplete' })]))

    const terminalHistory = history([root, historicalBinding, disposition.value])
    const forged = operation(disposition.value, { parts: [observedComment({ author: 'other-bot' })] })
    expect(
      readReviewRecovery({ ...terminalHistory, operations: [...terminalHistory.operations.slice(0, -1), forged] }),
    ).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: 'unbound', message: expect.stringContaining('unauthorized native author') }),
      ],
    })
  })

  test('surfaces an unconsumed replacement grant without admitting ordinary progression', () => {
    const root = reviewRoot({ id: 'interrupted-root-with-grant' })
    const historicalMandate = mandate()
    const historicalBinding = binding(historicalMandate, TEST_SCOPE)
    const disposition: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'review-interruption-interrupted-root-with-grant',
      runId: 'recovery-run',
      operationId: 'recovery-interruption-interrupted-root-with-grant',
      kind: 'review-interruption',
      payload: {
        rootAttemptId: root.recordId,
        historicalBinding: {
          scope: { repository: historicalBinding.repository, target: historicalBinding.target },
          recordId: historicalBinding.recordId,
          kind: 'workflow-binding',
        },
      },
    } as never)
    const freshBinding: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'binding-fresh-interrupted-root-with-grant',
      runId: 'recovery-run',
      operationId: 'recovery-binding-fresh-interrupted-root-with-grant',
      kind: 'workflow-binding',
      payload: {
        branch: 'feature/bounded',
        base: 'main',
        mandate: {
          scope: { repository: historicalMandate.repository, target: historicalMandate.target },
          recordId: historicalMandate.recordId,
          kind: 'mandate',
        },
      },
    } as never)

    expect(disposition).toMatchObject({ ok: true })
    expect(freshBinding).toMatchObject({ ok: true })
    if (!disposition.ok || !freshBinding.ok) return

    const grant: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'review-replacement-grant-review-interruption-interrupted-root-with-grant',
      runId: 'recovery-run',
      operationId: 'recovery-replacement-grant-interrupted-root-with-grant',
      kind: 'review-replacement-grant',
      payload: {
        rootAttemptId: root.recordId,
        dispositionId: disposition.value.recordId,
        candidateGitSHA: '2222222222222222222222222222222222222222',
        inputFormat: 'omp-build:review-input/4',
        input: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        binding: {
          scope: { repository: freshBinding.value.repository, target: freshBinding.value.target },
          recordId: freshBinding.value.recordId,
          kind: 'workflow-binding',
        },
      },
    } as never)

    expect(grant).toMatchObject({ ok: true })
    if (!grant.ok || grant.value.kind !== 'review-replacement-grant')
      throw new Error('invalid historical grant fixture')
    expect(grant.value.inputs).toHaveLength(3)
    expect(grant.value.inputs).toEqual(
      expect.arrayContaining([root.recordId, disposition.value.recordId, freshBinding.value.recordId]),
    )

    const ordinary = summarizeReviews(
      history([root, historicalBinding, disposition.value, freshBinding.value, grant.value]),
      fixtureReviewClassCatalogues(),
      null,
    )
    expect(ordinary).toMatchObject({ ok: false })
    if (!ordinary.ok)
      expect(ordinary.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'incomplete' })]))

    const recovered = readReviewRecovery(
      history([root, historicalBinding, disposition.value, freshBinding.value, grant.value]),
    )
    expect(recovered).toMatchObject({
      ok: true,
      value: {
        normalProgression: 'stopped',
        replacementGrant: { recordId: grant.value.recordId },
      },
    })

    const prefix = [root, historicalBinding, disposition.value, freshBinding.value]
    const recordedPrefix = history(prefix)
    const partialGrant = operation(grant.value, { status: 'incomplete', record: null })
    expect(
      readReviewRecovery({ ...recordedPrefix, operations: [...recordedPrefix.operations, partialGrant] }),
    ).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'incomplete', message: expect.stringContaining('is partial') })],
    })

    const conflictingGrant = { ...grant.value, payload: { ...grant.value.payload, candidateGitSHA: '3'.repeat(40) } }
    expect(readReviewRecovery(history([...prefix, grant.value, conflictingGrant]))).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: 'conflict',
          message: expect.stringContaining('contradictory duplicate evidence'),
        }),
      ],
    })
  })

  test('derives replacement inventory inputs from the historical root, disposition, and grant', () => {
    const root = reviewRoot({ id: 'historical-root-for-replacement' })
    const historicalMandate = mandate()
    const historicalBinding = binding(historicalMandate, TEST_SCOPE)
    const disposition: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'review-interruption-historical-root-for-replacement',
      runId: 'recovery-run',
      operationId: 'recovery-interruption-historical-root-for-replacement',
      kind: 'review-interruption',
      payload: {
        rootAttemptId: root.recordId,
        historicalBinding: {
          scope: { repository: historicalBinding.repository, target: historicalBinding.target },
          recordId: historicalBinding.recordId,
          kind: 'workflow-binding',
        },
      },
    } as never)
    const freshBinding: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'binding-fresh-historical-root-for-replacement',
      runId: 'recovery-run',
      operationId: 'recovery-binding-fresh-historical-root-for-replacement',
      kind: 'workflow-binding',
      payload: {
        branch: 'feature/bounded',
        base: 'main',
        mandate: {
          scope: { repository: historicalMandate.repository, target: historicalMandate.target },
          recordId: historicalMandate.recordId,
          kind: 'mandate',
        },
      },
    } as never)
    expect(disposition).toMatchObject({ ok: true })
    expect(freshBinding).toMatchObject({ ok: true })
    if (!disposition.ok || !freshBinding.ok) return

    const fresh = freshReviewInputs()
    const grant: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'review-replacement-grant-review-interruption-historical-root-for-replacement',
      runId: 'recovery-run',
      operationId: 'recovery-replacement-grant-historical-root-for-replacement',
      kind: 'review-replacement-grant',
      payload: {
        rootAttemptId: root.recordId,
        dispositionId: disposition.value.recordId,
        candidateGitSHA: '2222222222222222222222222222222222222222',
        inputFormat: 'omp-build:review-input/4',
        input: fresh.fingerprint,
        binding: {
          scope: { repository: freshBinding.value.repository, target: freshBinding.value.target },
          recordId: freshBinding.value.recordId,
          kind: 'workflow-binding',
        },
      },
    } as never)
    expect(grant).toMatchObject({ ok: true })
    if (!grant.ok) return

    const replacement: Result<CanonicalRecord> = buildRecord({
      ...reviewRoot({
        id: 'review-replacement-inventory-review-replacement-grant-review-interruption-historical-root-for-replacement',
        head: '2222222222222222222222222222222222222222',
        input: fresh.fingerprint,
        inputSnapshot: fresh,
      }),
      inputs: undefined,
      payload: {
        ...reviewRoot({
          id: 'review-replacement-inventory-review-replacement-grant-review-interruption-historical-root-for-replacement',
          head: '2222222222222222222222222222222222222222',
          input: fresh.fingerprint,
          inputSnapshot: fresh,
        }).payload,
        replacement: {
          rootAttemptId: root.recordId,
          dispositionId: disposition.value.recordId,
          grantId: grant.value.recordId,
        },
      },
    } as never)

    expect(replacement).toMatchObject({ ok: true })
    if (!replacement.ok) return
    expect(replacement.value.inputs).toEqual(
      expect.arrayContaining([root.recordId, disposition.value.recordId, grant.value.recordId]),
    )
    expect(replacement.value.inputs).toHaveLength(3)
  })

  test('consumes the grant once a replacement inventory exists and stays stopped until that inventory completes', () => {
    const root = reviewRoot({ id: 'historical-root-incomplete-replacement' })
    const historicalMandate = mandate()
    const historicalBinding = binding(historicalMandate, TEST_SCOPE)
    const disposition: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'review-interruption-historical-root-incomplete-replacement',
      runId: 'recovery-run',
      operationId: 'recovery-interruption-historical-root-incomplete-replacement',
      kind: 'review-interruption',
      payload: {
        rootAttemptId: root.recordId,
        historicalBinding: {
          scope: { repository: historicalBinding.repository, target: historicalBinding.target },
          recordId: historicalBinding.recordId,
          kind: 'workflow-binding',
        },
      },
    } as never)
    const freshBinding: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'binding-fresh-historical-root-incomplete-replacement',
      runId: 'recovery-run',
      operationId: 'recovery-binding-fresh-historical-root-incomplete-replacement',
      kind: 'workflow-binding',
      payload: {
        branch: 'feature/bounded',
        base: 'main',
        mandate: {
          scope: { repository: historicalMandate.repository, target: historicalMandate.target },
          recordId: historicalMandate.recordId,
          kind: 'mandate',
        },
      },
    } as never)
    expect(disposition).toMatchObject({ ok: true })
    expect(freshBinding).toMatchObject({ ok: true })
    if (!disposition.ok || !freshBinding.ok) return
    const fresh = freshReviewInputs()
    const grant: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'review-replacement-grant-review-interruption-historical-root-incomplete-replacement',
      runId: 'recovery-run',
      operationId: 'recovery-replacement-grant-historical-root-incomplete-replacement',
      kind: 'review-replacement-grant',
      payload: {
        rootAttemptId: root.recordId,
        dispositionId: disposition.value.recordId,
        candidateGitSHA: '2222222222222222222222222222222222222222',
        inputFormat: 'omp-build:review-input/4',
        input: fresh.fingerprint,
        binding: {
          scope: { repository: freshBinding.value.repository, target: freshBinding.value.target },
          recordId: freshBinding.value.recordId,
          kind: 'workflow-binding',
        },
      },
    } as never)
    expect(grant).toMatchObject({ ok: true })
    if (!grant.ok) return
    const replacement: Result<CanonicalRecord> = buildRecord({
      ...reviewRoot({
        id: 'review-replacement-inventory-review-replacement-grant-review-interruption-historical-root-incomplete-replacement',
        head: '2222222222222222222222222222222222222222',
        input: fresh.fingerprint,
        inputSnapshot: fresh,
      }),
      inputs: undefined,
      payload: {
        ...reviewRoot({
          id: 'review-replacement-inventory-review-replacement-grant-review-interruption-historical-root-incomplete-replacement',
          head: '2222222222222222222222222222222222222222',
          input: fresh.fingerprint,
          inputSnapshot: fresh,
        }).payload,
        replacement: {
          rootAttemptId: root.recordId,
          dispositionId: disposition.value.recordId,
          grantId: grant.value.recordId,
        },
      },
    } as never)
    expect(replacement).toMatchObject({ ok: true })
    if (!replacement.ok) return

    const recovered = readReviewRecovery(
      history([root, historicalBinding, disposition.value, freshBinding.value, grant.value, replacement.value]),
    )
    expect(recovered).toMatchObject({
      ok: true,
      value: { normalProgression: 'stopped', replacementGrant: null },
    })
  })
})
