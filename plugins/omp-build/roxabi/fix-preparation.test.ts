import { describe, expect, it } from 'vitest'
import { confirmingUwOperations } from '../testing/action-input-fixtures.ts'
import type { FixRecord, FixTarget } from './fix-contract.ts'
import { prepareStandaloneFix } from './fix-preparation.ts'

function openTarget(): FixTarget {
  return {
    repository: 'Acme/app',
    target: 'Acme/app#42',
    number: 42,
    kind: 'pull-request',
    state: 'open',
    candidateGitSHA: 'a'.repeat(40),
    baseGitSHA: 'b'.repeat(40),
  }
}

describe('standalone fix preparation', () => {
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
        operations: confirmingUwOperations(),
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
    const operations = confirmingUwOperations()
    const prepareAction = operations.prepareAction
    let observedCode: unknown
    operations.prepareAction = async (request) => {
      observedCode = request.code
      return prepareAction(request)
    }
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
        operations,
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
    expect(observedCode).toEqual({
      repository: 'Acme/app',
      base: 'b'.repeat(40),
      head: 'a'.repeat(40),
      referenceCommit: 'a'.repeat(40),
    })
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

  it('does not publish when a three-hop authority abort reaches standalone preparation', async () => {
    const controller = new AbortController()
    let published = 0
    const result = await prepareStandaloneFix(
      {
        cwd: '/worktree',
        reference: '#42',
        rawOperatorRequest: { request: 'fix it' },
        scope: 'src/auth only',
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
            agent: 'R-review-fix-intake',
            task: 'inspect correction scope',
            solutionSpace: 'correction evidence only',
          },
        ],
        operations: confirmingUwOperations(),
      },
      {
        resolveExplicit: async () => openTarget(),
        resolveContext: async () => null,
      },
      {
        publish: async () => {
          published += 1
          return { ok: true, value: undefined }
        },
      },
      {
        nextReviewStep: async () => {
          queueMicrotask(() =>
            queueMicrotask(() =>
              queueMicrotask(() => {
                controller.abort()
              }),
            ),
          )
          return { action: 'fix' }
        },
      },
      controller.signal,
    )

    expect(result).toEqual({ ok: false, diagnostics: ['fix-run-interrupted-cleanup-unproven'] })
    expect(published).toBe(0)
  })
})
