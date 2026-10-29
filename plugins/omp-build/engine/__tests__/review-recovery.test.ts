import { describe, expect, test } from 'vitest'
import { freshReviewInputs } from '../../testing/action-input-fixtures.ts'
import { reviewRoot, TEST_INPUT, TEST_SCOPE } from '../../testing/record-builders.ts'
import { history } from '../../testing/record-history.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { buildRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Result } from '../result.ts'
import * as reviewRecovery from '../review-recovery.ts'
import { readReviewRecovery } from '../review-recovery.ts'
import { summarizeReviews } from '../review-state.ts'
import { TAXONOMY } from './record-test-support.ts'
import {
  binding,
  featureMandate,
  mandate,
  SCOPE as WORKFLOW_SCOPE,
  history as workflowHistory,
} from './workflow-test-support.ts'

describe('review recovery', () => {
  test('selects an unfinished initial pull-request root that can still be interrupted', () => {
    const root = reviewRoot({ id: 'interruptible-root' })
    expect(reviewRecovery.interruptiblePullRequestRoot(history([root]))).toMatchObject({
      recordId: 'interruptible-root',
    })
    const disposition: Result<CanonicalRecord> = buildRecord({
      version: 1,
      repository: TEST_SCOPE.repository,
      target: TEST_SCOPE.target,
      recordId: 'review-interruption-interruptible-root',
      runId: 'recovery-run',
      operationId: 'recovery-interruption-interruptible-root',
      kind: 'review-interruption',
      payload: {
        rootAttemptId: root.recordId,
        historicalBinding: {
          scope: TEST_SCOPE,
          recordId: 'binding-interruptible-root',
          kind: 'workflow-binding',
        },
      },
    } as never)
    expect(disposition).toMatchObject({ ok: true })
    if (!disposition.ok) return
    expect(reviewRecovery.interruptiblePullRequestRoot(history([root, disposition.value]))).toBeNull()
  })

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

    const ordinary = summarizeReviews(history([root, historicalBinding, disposition.value]), TAXONOMY, null)
    expect(ordinary).toMatchObject({ ok: false })
    if (!ordinary.ok)
      expect(ordinary.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'incomplete' })]))
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
    if (!grant.ok) return
    expect(grant.value.inputs).toHaveLength(3)
    expect(grant.value.inputs).toEqual(
      expect.arrayContaining([root.recordId, disposition.value.recordId, freshBinding.value.recordId]),
    )

    const ordinary = summarizeReviews(
      history([root, historicalBinding, disposition.value, freshBinding.value, grant.value]),
      TAXONOMY,
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
  })

  test('refuses terminal proof when no historical binding can reconstruct the root input', () => {
    const root = reviewRoot({ id: 'unbound-interrupted-root' })
    const proveHistoricalReviewAssociation = Reflect.get(reviewRecovery, 'proveHistoricalReviewAssociation')

    expect(
      proveHistoricalReviewAssociation({
        root,
        bindings: [],
        mandates: [],
        histories: [history([root])],
      }),
    ).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'unbound' })]) })
  })

  test('confirms reconstructed historical input against the interrupted root persisted digest', () => {
    const root = reviewRoot({ id: 'digest-interrupted-root', input: TEST_INPUT })
    expect(reviewRecovery.confirmHistoricalReviewInputMatch(root, TEST_INPUT)).toMatchObject({
      ok: true,
      value: { recordId: root.recordId },
    })
    expect(reviewRecovery.confirmHistoricalReviewInputMatch(root, 'b'.repeat(64))).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'unbound' })]),
    })
  })

  test('proves a unique historical binding and accepted Spec for an interrupted root', () => {
    const mandated = featureMandate()
    const historicalBinding = binding(mandated)
    const root = {
      ...reviewRoot({ id: 'bound-interrupted-root' }),
      repository: WORKFLOW_SCOPE.repository,
      target: WORKFLOW_SCOPE.target,
    }
    const proved = reviewRecovery.proveHistoricalReviewAssociation({
      root,
      bindings: [historicalBinding as Extract<CanonicalRecord, { kind: 'workflow-binding' }>],
      mandates: [mandated],
      histories: [workflowHistory([mandated, historicalBinding])],
    })

    expect(proved).toMatchObject({
      ok: true,
      value: {
        binding: { recordId: historicalBinding.recordId },
        mandate: { recordId: mandated.recordId },
        accepted: { snapshot: { raw: { bodySha256: mandated.payload.ownSpec.snapshot.raw.bodySha256 } } },
      },
    })
  })

  test('authenticates the issue-scoped mandate referenced by the PR-scoped historical binding', () => {
    const issueScope = { repository: WORKFLOW_SCOPE.repository, target: `${WORKFLOW_SCOPE.repository}#7` }
    const mandated = roxabiWorkflowFixtures().featureMandate(issueScope, {
      recordId: 'issue-mandate-for-recovery',
      runId: 'issue-mandate-run',
      operationId: 'issue-mandate-operation',
      branch: 'feature/recovery',
      base: 'main',
      lineageHead: null,
      body: 'ship the bounded workflow',
    })
    if (mandated.kind !== 'mandate') throw new Error('fixture mandate is not a mandate')
    const historicalBinding = binding(mandated)
    const histories = [workflowHistory([mandated], issueScope), workflowHistory([historicalBinding])]
    const root = {
      ...reviewRoot({ id: 'issue-bound-interrupted-root' }),
      repository: WORKFLOW_SCOPE.repository,
      target: WORKFLOW_SCOPE.target,
    }

    expect(
      reviewRecovery.proveHistoricalReviewAssociation({
        root,
        bindings: [historicalBinding as Extract<CanonicalRecord, { kind: 'workflow-binding' }>],
        mandates: [mandated],
        histories,
      }),
    ).toMatchObject({
      ok: true,
      value: {
        binding: { recordId: historicalBinding.recordId },
        mandate: { recordId: mandated.recordId, target: issueScope.target },
      },
    })
  })

  test('refuses a PR-scoped mandate reference when the historical mandate is issue scoped', () => {
    const issueScope = { repository: WORKFLOW_SCOPE.repository, target: `${WORKFLOW_SCOPE.repository}#7` }
    const mandated = roxabiWorkflowFixtures().featureMandate(issueScope, {
      recordId: 'issue-mandate-wrong-reference',
      runId: 'issue-mandate-wrong-reference-run',
      operationId: 'issue-mandate-wrong-reference-operation',
      branch: 'feature/recovery',
      base: 'main',
      lineageHead: null,
      body: 'ship the bounded workflow',
    })
    if (mandated.kind !== 'mandate') throw new Error('fixture mandate is not a mandate')
    const wrongReferenceBinding = binding(
      { ...mandated, repository: WORKFLOW_SCOPE.repository, target: WORKFLOW_SCOPE.target },
      WORKFLOW_SCOPE,
    )
    const histories = [workflowHistory([mandated], issueScope), workflowHistory([wrongReferenceBinding])]
    const root = {
      ...reviewRoot({ id: 'wrong-reference-interrupted-root' }),
      repository: WORKFLOW_SCOPE.repository,
      target: WORKFLOW_SCOPE.target,
    }

    expect(
      reviewRecovery.proveHistoricalReviewAssociation({
        root,
        bindings: [wrongReferenceBinding as Extract<CanonicalRecord, { kind: 'workflow-binding' }>],
        mandates: [mandated],
        histories,
      }),
    ).toMatchObject({ ok: false, diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'unbound' })]) })
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
