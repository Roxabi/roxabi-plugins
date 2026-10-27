import { decodeHistory, encodeRecord } from '../adapters/github/history-codec.ts'
import { githubScope, readGitHubHistory } from '../adapters/github/transport.ts'
import { TAXONOMY } from '../engine/__tests__/record-test-support.ts'
import {
  binding,
  featureMandate,
  SCOPE,
  history as workflowHistory,
} from '../engine/__tests__/workflow-test-support.ts'
import type { History } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { proveHistoricalReviewAssociation } from '../engine/review-recovery.ts'
import {
  reviewRoot,
  submission,
  synthesisInventory,
  TEST_HEAD,
  TEST_INPUT_SNAPSHOT,
} from '../testing/record-builders.ts'
import { contribution, decision, finalReview } from '../testing/record-decisions.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { PreparedReviewInputs } from './review-input-contract.ts'
import { recoveryGhTransport } from './review-recovery-gh-transport-test-support.ts'
import { boundSemanticFromHistoricalAssociation, reconstructHistoricalReviewInput } from './review-recovery-input.ts'

type NativeComment = {
  id: number
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}
type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>
export const recoverySmokeCwd = '/recovery-publication-smoke'
export const recoveryFreshInput = 'b'.repeat(64)
function scoped<T extends CanonicalRecord>(record: T): T {
  return { ...record, repository: SCOPE.repository, target: SCOPE.target }
}

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

export function recoveryFixture(
  options: { postResponseAuthor?: string; postStoredAuthor?: string; associations?: 'single' | 'second' | 'none' } = {},
) {
  const scope = githubScope(SCOPE.repository, 42)
  const comments = new Map<number, NativeComment[]>()
  let nextCommentId = 1
  const add = (number: number, body: string, author = 'automation') => {
    const value: NativeComment = {
      id: nextCommentId++,
      body,
      user: { login: author },
      created_at: '2026-10-27T00:00:00Z',
      updated_at: '2026-10-27T00:00:01Z',
    }
    const entries = comments.get(number) ?? []
    entries.push(value)
    comments.set(number, entries)
    return value
  }
  const source = (): History => ({
    scope,
    expectedAuthor: 'automation',
    stopAuthor: 'github-actions[bot]',
    complete: true,
    comments: (comments.get(42) ?? []).map((comment) => ({
      locator: `${scope.target}:comment:${comment.id}`,
      nativeId: String(comment.id),
      body: comment.body,
      author: comment.user.login,
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    })),
    diagnostics: [],
  })
  const seed = (record: CanonicalRecord) => {
    const encoded = encodeRecord(record, source(), null)
    if (!encoded.ok) throw new Error(encoded.diagnostics.map(({ code }) => code).join(','))
    for (const body of encoded.value) add(42, body)
  }
  const gh = recoveryGhTransport({
    comments,
    append: add,
    postResponseAuthor: options.postResponseAuthor,
    postStoredAuthor: options.postStoredAuthor,
  })
  const mandate = featureMandate()
  const historicalBinding = binding(mandate)
  const candidate = scoped(
    reviewRoot({ id: 'interrupted-native-root', input: 'historical-input', inputSnapshot: TEST_INPUT_SNAPSHOT }),
  )
  const association = proveHistoricalReviewAssociation({
    root: candidate,
    bindings: [historicalBinding as Extract<CanonicalRecord, { kind: 'workflow-binding' }>],
    mandates: [mandate],
    histories: [workflowHistory([mandate, historicalBinding])],
  })
  if (!association.ok) throw new Error(association.diagnostics.map(({ code }) => code).join(','))
  const semantic = boundSemanticFromHistoricalAssociation(association.value)
  if ('ok' in semantic) throw new Error(semantic.reason)
  const reconstructed = reconstructHistoricalReviewInput({ root: candidate, semantic })
  if (reconstructed === null) throw new Error('historical input did not reconstruct')
  const root = scoped(
    reviewRoot({
      id: candidate.recordId,
      input: options.associations === 'none' ? 'd'.repeat(64) : reconstructed,
      inputSnapshot: TEST_INPUT_SNAPSHOT,
    }),
  )
  const secondMandate =
    options.associations === 'second' || options.associations === 'none'
      ? { ...mandate, recordId: 'mandate-2', operationId: 'op-mandate-2' }
      : null
  const secondBinding = secondMandate === null ? null : binding(secondMandate)
  seed(mandate)
  seed(historicalBinding)
  if (secondMandate !== null && secondBinding !== null) {
    seed(secondMandate)
    seed(secondBinding)
  }
  seed(root)
  return {
    gh,
    historicalBinding,
    duplicateBindingEncoding: () =>
      encodeRecord(
        { ...historicalBinding, operationId: 'op-binding-mandate-1-contradictory-duplicate' },
        source(),
        null,
      ),
    commentCount: () => comments.get(42)?.length ?? 0,
    history: async () =>
      decodeHistory(await readGitHubHistory(scope, withRoxabiGitHubPolicy({ cwd: recoverySmokeCwd, gh }))),
  }
}

export function completedReplacementRecords(replacement: ReviewRoot): CanonicalRecord[] {
  const rootId = replacement.recordId
  const input = replacement.payload.input
  if (input === null) throw new Error('replacement input missing')
  const specSlot = replacement.payload.slots.find((slot) => slot.phase === 'spec')
  const panelSlot = replacement.payload.slots.find((slot) => slot.phase === 'panel')
  if (specSlot === undefined || panelSlot === undefined) throw new Error('replacement slots missing')
  const specStructured = { findings: [], specRows: [] }
  const spec = scoped(
    contribution({
      id: 'replacement-spec',
      inventoryId: rootId,
      phase: 'spec',
      role: 'R-review-spec',
      slotId: specSlot.slotId,
      chunk: null,
      findings: [],
      rawAttempts: [
        submission({ id: 'child-replacement-spec', structuredOutput: { status: 'valid', data: specStructured } }),
      ],
      structured: specStructured,
    }),
  )
  const panel = scoped(
    contribution({
      id: 'replacement-panel',
      inventoryId: rootId,
      phase: 'panel',
      role: panelSlot.role,
      slotId: panelSlot.slotId,
      chunk: panelSlot.chunk,
    }),
  )
  const synthesisTemplate = synthesisInventory({
    id: 'replacement-synthesis',
    rootId,
    head: replacement.payload.candidateGitSHA,
    input,
  })
  const synthesis = scoped({
    ...synthesisTemplate,
    payload: {
      ...synthesisTemplate.payload,
      slots: synthesisTemplate.payload.slots.map((slot) => ({ ...slot, slotId: 'synthesis' })),
    },
  })
  const judgment = scoped(
    decision({
      id: 'replacement-decision',
      originalContributionId: 'replacement-synthesis-source',
      sourceContributionIds: [spec.recordId, panel.recordId],
      findings: [
        {
          id: 'replacement-finding',
          label: 'issue',
          impactReason: 'The selected region remains stale.',
          state: 'usable',
          sourceFindingIds: [`${panel.recordId}:f0`],
          description: 'Persist the selected region.',
        },
      ],
    }),
  )
  const synthesisContribution = scoped(
    contribution({
      id: 'replacement-synthesis-source',
      inventoryId: synthesis.recordId,
      phase: 'synthesis',
      role: 'R-synthesis',
      slotId: 'synthesis',
      chunk: null,
      content: 'decision',
      rawAttempts: [
        {
          attemptIndex: 0,
          data: judgment.payload.judgment,
          raw: { structuredOutput: { status: 'valid', data: judgment.payload.judgment } },
          partialText: null,
        },
      ],
      structured: judgment.payload.judgment,
    }),
  )
  const review = scoped(
    finalReview({
      id: 'replacement-final',
      head: replacement.payload.candidateGitSHA,
      input,
      inventoryIds: [rootId, synthesis.recordId],
      decisionId: judgment.recordId,
    }),
  )
  return [spec, panel, synthesis, synthesisContribution, judgment, review]
}
