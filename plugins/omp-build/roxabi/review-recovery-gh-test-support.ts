import { decodeHistory, encodeRecord } from '../adapters/github/history-codec.ts'
import { githubScope, readGitHubHistory } from '../adapters/github/transport.ts'
import { binding, SCOPE } from '../engine/__tests__/workflow-test-support.ts'
import { actionInputDigest, validateActionInputs } from '../engine/action-input.ts'
import type { DecodedHistory, History } from '../engine/history-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { resolveAcceptedSpec } from '../engine/workflow-accepted-spec.ts'
import { acceptedActionInputs } from '../testing/action-input-fixtures.ts'
import { reviewRoot, submission, synthesisInventory } from '../testing/record-builders.ts'
import { contribution, decision, finalReview } from '../testing/record-decisions.ts'
import { roxabiWorkflowFixtures } from '../testing/roxabi-presets.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { recoveryGhTransport } from './review-recovery-gh-transport-test-support.ts'
import { boundSemanticFromHistoricalAssociation, reconstructHistoricalReviewInput } from './review-recovery-input.ts'

export { preparedReview, recoveryFreshInput } from './review-recovery-prepared-test-support.ts'

type NativeComment = {
  id: number
  body: string
  user: { login: string }
  created_at: string
  updated_at: string
}
type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>
export const recoverySmokeCwd = '/recovery-publication-smoke'
const ISSUE_SCOPE = { repository: SCOPE.repository, target: `${SCOPE.repository}#7` }
const { featureMandate: featureIssueMandate, identityAllocation } = roxabiWorkflowFixtures()

function issueNumber(scope: { repository: string; target: string }): number {
  const prefix = `${scope.repository}#`
  const number = Number(scope.target.slice(prefix.length))
  if (!scope.target.startsWith(prefix) || !Number.isSafeInteger(number) || number < 1)
    throw new Error('fixture scope must be a GitHub issue')
  return number
}
function scoped<T extends CanonicalRecord>(record: T): T {
  return { ...record, repository: SCOPE.repository, target: SCOPE.target }
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
      updated_at: '2026-10-27T00:00:00Z',
    }
    const entries = comments.get(number) ?? []
    entries.push(value)
    comments.set(number, entries)
    return value
  }
  const source = (historyScope: History['scope']): History => {
    const number = issueNumber(historyScope)
    return {
      scope: historyScope,
      expectedAuthor: 'automation',
      stopAuthor: 'github-actions[bot]',
      complete: true,
      comments: (comments.get(number) ?? []).map((comment) => ({
        locator: `${historyScope.target}:comment:${comment.id}`,
        nativeId: String(comment.id),
        body: comment.body,
        author: comment.user.login,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
      })),
      diagnostics: [],
    }
  }
  const seed = (record: CanonicalRecord, externalHistories: readonly DecodedHistory[] = []) => {
    const recordScope = githubScope(record.repository, issueNumber(record))
    const encoded = encodeRecord(record, source(recordScope), null, externalHistories)
    if (!encoded.ok) throw new Error(encoded.diagnostics.map(({ code }) => code).join(','))
    for (const body of encoded.value) add(issueNumber(record), body)
  }
  const gh = recoveryGhTransport({
    comments,
    append: add,
    postResponseAuthor: options.postResponseAuthor,
    postStoredAuthor: options.postStoredAuthor,
  })
  const mandate = featureIssueMandate(ISSUE_SCOPE, {
    recordId: 'issue-mandate-1',
    runId: 'issue-mandate-run-1',
    operationId: 'issue-mandate-operation-1',
    branch: 'feature/bounded',
    base: 'main',
    lineageHead: null,
    body: 'ship the bounded workflow',
  })
  if (mandate.kind !== 'mandate') throw new Error('fixture mandate is not a mandate')
  const mandateIdentities = mandate.payload.ownSpec.identityAllocations.map(({ scope, recordId }) =>
    identityAllocation(scope, recordId),
  )
  const historicalBinding = binding(mandate)
  for (const identity of mandateIdentities) seed(identity)
  seed(mandate)
  const issueHistory = decodeHistory(source(githubScope(ISSUE_SCOPE.repository, issueNumber(ISSUE_SCOPE))))
  const accepted = resolveAcceptedSpec(mandate, [issueHistory])
  if (!accepted.ok) throw new Error(accepted.evidence.map(({ code }) => code).join(','))
  const semantic = boundSemanticFromHistoricalAssociation({
    binding: historicalBinding as Extract<CanonicalRecord, { kind: 'workflow-binding' }>,
    mandate,
    accepted: accepted.spec,
  })
  if ('ok' in semantic) throw new Error(semantic.reason)
  if (semantic.mode !== 'bound') throw new Error('historical association is not bound')
  const acceptedInputs = acceptedActionInputs(mandate, 'review')
  const manifest = {
    ...acceptedInputs.manifest,
    configuration: {
      ...acceptedInputs.manifest.configuration,
      digest: options.associations === 'none' ? 'e'.repeat(64) : semantic.config.digest,
    },
  }
  const snapshot = {
    format: acceptedInputs.format,
    manifest,
    fingerprint: actionInputDigest(manifest),
    stageSources: acceptedInputs.stageSources,
  }
  const validated = validateActionInputs(snapshot)
  if (!validated.ok) throw new Error(validated.diagnostics.map((item) => item.message).join('; '))
  const candidate = scoped(
    reviewRoot({ id: 'interrupted-native-root', input: snapshot.fingerprint, inputSnapshot: snapshot }),
  )
  const reconstructed = reconstructHistoricalReviewInput({ root: candidate, semantic })
  if (options.associations !== 'none' && reconstructed === null) throw new Error('historical input did not reconstruct')
  const root = scoped(
    reviewRoot({
      id: candidate.recordId,
      input: snapshot.fingerprint,
      inputSnapshot: snapshot,
    }),
  )
  const secondMandate =
    options.associations === 'second' || options.associations === 'none'
      ? {
          ...mandate,
          recordId: 'mandate-2',
          operationId: 'op-mandate-2',
          payload: { ...mandate.payload, config: { ...mandate.payload.config, digest: 'f'.repeat(64) } },
        }
      : null
  const secondBinding = secondMandate === null ? null : binding(secondMandate)
  seed(historicalBinding, [issueHistory])
  if (secondMandate !== null && secondBinding !== null) {
    seed(secondMandate)
    seed(secondBinding, [decodeHistory(source(githubScope(ISSUE_SCOPE.repository, issueNumber(ISSUE_SCOPE))))])
  }
  seed(root, [issueHistory])
  return {
    gh,
    historicalBinding,
    duplicateBindingEncoding: () =>
      encodeRecord(
        { ...historicalBinding, operationId: 'op-binding-mandate-1-contradictory-duplicate' },
        source(scope),
        null,
        [issueHistory],
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
