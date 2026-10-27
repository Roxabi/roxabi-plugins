import { TAXONOMY } from '../engine/__tests__/record-test-support.ts'
import { SCOPE } from '../engine/__tests__/workflow-test-support.ts'
import { TEST_HEAD, TEST_INPUT_SNAPSHOT } from '../testing/record-builders.ts'
import type { PreparedReviewInputs } from './review-input-contract.ts'
export const recoveryFreshInput = 'b'.repeat(64)

export function preparedReview(): { ok: true; value: PreparedReviewInputs } {
  return {
    ok: true,
    value: {
      scope: SCOPE,
      context: {
        ...SCOPE,
        number: 42,
        candidateGitSHA: TEST_HEAD,
        input: recoveryFreshInput,
        subject: { kind: 'pull-request' },
      },
      pr: { number: 42, head: TEST_HEAD, base: 'main', baseGitSHA: 'c'.repeat(40), branch: 'feature/bounded' },
      automationLogin: 'automation',
      capture: {
        ok: true,
        input: recoveryFreshInput,
        body: TEST_INPUT_SNAPSHOT.body,
        semantic: null as never,
        semanticCanon: 'recovery-fixture-semantic',
      },
      observedEvidence: {
        reviewInput: recoveryFreshInput,
        candidate: { head: TEST_HEAD, base: 'c'.repeat(40) },
        pullRequest: TEST_INPUT_SNAPSHOT.body,
        stack: { candidate: null, base: null },
        resolvedSpec: null,
      },
      inputSnapshot: TEST_INPUT_SNAPSHOT,
      issueSpec: null,
      semanticContext: null as never,
      tier: 'S',
      warnings: [],
      chunks: [
        {
          index: 0,
          delta: ['src/recovery.ts'],
          diff: 'diff --git a/src/recovery.ts b/src/recovery.ts',
          files: [],
          digest: 'chunk-1',
        },
      ],
      roster: {
        delta: ['src/recovery.ts'],
        tier: 'S',
        chunks: 1,
        claims: [],
        pricedClaimOk: true,
        specDraft: false,
        axialAdr: false,
        stackPaths: { frontendPath: 'web', sharedUi: 'ui', backendPath: 'src' },
        config: { maxAgents: 1, axialOverride: 'default', overrides: {}, warnings: [] },
      },
      config: { canonicalClasses: TAXONOMY, chunker: 'fixture', digest: 'fixture' },
      policy: { version: 'baseline' },
      semantic: {
        assets: null as never,
        spec: null as never,
        prompts: { spec: 'Assess the specification.', panel: 'Assess the candidate.' } as never,
      },
      rawOperatorRequest: null,
    },
  }
}
