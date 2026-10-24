import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanonicalRecord } from '../dist/contracts.js'
import type { NativeChildResult } from '../omp/review-runtime/contracts'
import { TEST_HEAD, TEST_INPUT_SNAPSHOT } from '../testing/record-builders.ts'

const published = vi.hoisted((): CanonicalRecord[] => [])

vi.mock('./github-publisher', () => ({
  createGitHubRecordPublisher: () => ({
    publish: async (record: CanonicalRecord) => {
      published.push(record)
      return { ok: true as const }
    },
  }),
}))

import { CanonicalReviewRunner, type PreparedReviewInputs } from './review-runner'

describe('CanonicalReviewRunner native contribution publication', () => {
  beforeEach(() => published.splice(0))

  it('binds an allocated native child ID to its logical slot in one complete contribution', async () => {
    const input: PreparedReviewInputs = {
      context: {
        repository: 'acme/widgets',
        target: 'acme/widgets#42',
        number: 42,
        candidateGitSHA: TEST_HEAD,
        input: null,
        runId: 'review-run',
        operationId: 'review-operation',
        subject: { kind: 'pull-request' },
      },
      pr: { base: 'main', baseGitSHA: '2222222222222222222222222222222222222222' },
      chunks: [
        {
          index: 0,
          delta: ['src/widget.ts'],
          diff: '@@ -1 +1 @@\n-old\n+new',
          files: [{ path: 'src/widget.ts', text: 'export const widget = true\n', deleted: false }],
          digest: 'widget change',
        },
      ],
      roster: {
        delta: ['src/widget.ts'],
        tier: 'F-lite',
        chunks: 1,
        claims: [],
        pricedClaimOk: false,
        specDraft: false,
        axialAdr: false,
        stackPaths: { frontendPath: 'apps/web', sharedUi: '', backendPath: 'apps/api' },
        config: { maxAgents: 5, axialOverride: 'default', overrides: {}, warnings: [] },
      },
      config: { canonicalClasses: ['missing-input-validation'], chunker: 'chunker.py', digest: 'digest.py' },
      policy: { version: 'baseline' },
      semantic: { spec: 'spec', panel: 'panel', synthesis: 'synthesis' },
      observedEvidence: {
        reviewInput: null,
        candidate: { head: TEST_HEAD, base: '2222222222222222222222222222222222222222' },
        pullRequest: null,
        stack: { candidate: null, base: null },
        resolvedSpec: null,
        semctx: null,
        assertledger: null,
      },
      inputSnapshot: TEST_INPUT_SNAPSHOT,
      canonicalClasses: ['missing-input-validation'],
      authorize: async () => ({ ok: true }),
    }
    const runner = new CanonicalReviewRunner(input, {
      cwd: '/fixture',
      readAuthor: 'roxabi-bot',
      writerLogin: 'roxabi-bot',
      gh: async () => '[]',
    })
    const prepared = runner.initialBatch()
    const inventoryPublication = await runner.publishInventory(prepared)
    expect(inventoryPublication).toEqual({ ok: true })
    const inventory = published.find(
      (record): record is Extract<CanonicalRecord, { kind: 'review-attempt' }> => record.kind === 'review-attempt',
    )
    if (inventory === undefined) throw new Error('expected initial inventory publication')
    const child: NativeChildResult = {
      id: 'spec-2',
      expectedId: 'spec',
      submissions: [
        {
          attemptIndex: 0,
          data: { findings: [] },
          raw: { structuredOutput: { data: { findings: [] } } },
          partialText: null,
        },
      ],
      proofEvidence: null,
      raw: { id: 'spec-2', status: 'completed' },
      partialText: null,
      structured: { findings: [] },
      usable: true,
      reason: null,
    }

    await runner.publishRawContribution(prepared, child)

    const contributions = published.filter(
      (record): record is Extract<CanonicalRecord, { kind: 'contribution' }> => record.kind === 'contribution',
    )
    expect(contributions).toHaveLength(1)
    expect(contributions[0]).toMatchObject({
      inputs: [inventory.recordId],
      payload: {
        host: { slotId: 'spec', childId: 'spec-2' },
        native: { completion: 'completed', strict: 'valid' },
      },
    })
  })
})
