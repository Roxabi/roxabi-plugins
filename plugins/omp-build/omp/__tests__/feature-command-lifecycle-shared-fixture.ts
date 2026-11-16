import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import type { PreparedEpicReview } from '../../roxabi/epic-range-finalization.ts'
import type { ContinueFeatureResult, FeatureWorkflow } from '../../roxabi/feature-contract'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { batch } from './feature-command-lifecycle-fixture.ts'

export function workflow(impl: Partial<FeatureWorkflow> = {}): FeatureWorkflow {
  return {
    continueFeature: async () => ({ kind: 'blocked', reason: 'unconfigured' }),
    consumeWatchExit: async () => ({ kind: 'blocked', reason: 'watch-unconfigured' }),
    publishFeatureNativeResult: async () => {
      throw new Error('unexpected-native-publication')
    },
    requestFeatureSessionPause: async () => ({ kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }),
    ...impl,
  }
}

export const review: PreparedEpicReview = {
  context: {
    repository: 'acme/widgets',
    target: 'acme/widgets#12',
    number: 12,
    candidateGitSHA: 'b'.repeat(40),
    input: null,
    runId: 'review-run',
    operationId: 'final-review',
    subject: { kind: 'epic-range', range: `${'a'.repeat(40)}..${'b'.repeat(40)}` },
  },
  prepared: {
    stage: 'synthesis',
    rootAttemptId: 'root-attempt',
    inventory: {},
    batch: batch('final-review'),
  },
  publisher: {
    authorize: async () => ({ ok: true }),
    publishInventory: async () => ({ ok: true }),
    publishRawContribution: async (_prepared, child) => ({ id: 'contribution', child }),
    completeStage: async () => null,
    publishRequiredStop: async () => ({ ok: true }),
    stop: async () => undefined,
  },
}

function admittedCiCorrection(): Extract<ContinueFeatureResult, { kind: 'admitted-ci-correction' }> {
  const scope = { repository: 'acme/widgets', target: 'acme/widgets#42' }
  const canonical = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Preserve the confirmed CI correction scope.' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error('expected canonical correction Spec')
  const body = renderIssueSpecBody(canonical.value)
  const parsed = parseIssueSpecBody({ uw: scope, raw: rawSource(scope.target, body, null) })
  if (parsed.status !== 'conformant') throw new Error('expected native correction Spec')
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(scope, {
    recordId: 'feature-mandate-42',
    body,
    ownSpec: fixtures.ownSpecFromSnapshot(scope, parsed.snapshot),
  })
  const resolved = resolveAcceptedSpec(mandate, [fixtures.historyFrom([mandate])])
  if (!resolved.ok) throw new Error(`unconfirmed correction Spec: ${JSON.stringify(resolved.evidence)}`)
  const ownSpec = resolved.spec
  return {
    kind: 'admitted-ci-correction',
    reference: '#42',
    attributionRecordId: 'ci-attribution-42',
    uw: { ownSpec, children: [] },
  }
}

/** Every result kind that hands work on, one each. */
export function handedWork(scenario: 'principal' | 'inhibited' | 'active'): ContinueFeatureResult[] {
  return [
    {
      kind: 'action',
      node: 'implement',
      followUp: batch('matrix-action'),
      start: {
        scope: { repository: 'acme/widgets', target: 'acme/widgets#42' },
        recordId: `matrix-start-${scenario}`,
        kind: 'action-receipt',
      },
    },
    {
      kind: 'watch',
      command: "bash '/repo/plugins/omp-build/skills/ci-watch/ci-watch.sh' '12' --merge-mode native --base 'main'",
    },
    { kind: 'review', pr: 7 },
    {
      kind: 'fix',
      reference: '#7',
      reviewId: 'review-7',
      scope: 'preserve the approved region',
      requiredFeatureMandate: {
        scope: { repository: 'acme/widgets', target: 'acme/widgets#42' },
        recordId: 'feature-mandate',
        kind: 'mandate',
      },
    },
    admittedCiCorrection(),
    { kind: 'epic-final-review', review },
  ]
}
