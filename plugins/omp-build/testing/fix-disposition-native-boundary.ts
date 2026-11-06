import { decodeHistory, readGitHubHistory } from '../dist/contracts.js'
import type { NativePort, RecordPublisher } from '../roxabi/fix-contract.ts'
import { captureDispositionSource } from '../roxabi/fix-disposition-capture.ts'
import { createFixDispositionStore } from '../roxabi/fix-disposition-store.ts'
import { createIdentity } from '../roxabi/fix-entry-lifecycle.ts'
import { resolvePublishBinding } from '../roxabi/fix-entry-target-binding.ts'
import { defaultGh } from '../roxabi/fix-entry-target-core.ts'
import { createResolver } from '../roxabi/fix-entry-target-resolver.ts'
import { executeDecision, runReviewBoundFixWorkflow } from '../roxabi/fix-execution-runner.ts'
import { prepareReviewBoundFix } from '../roxabi/fix-preparation.ts'
import { createGitHubRecordPublisher } from '../roxabi/github-publisher.ts'
import type { OperatorPort } from '../roxabi/uw-contract.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { REVIEW_SCOPE } from './feature-review-fixture.ts'
import type { ReviewDriver } from './native-review-driver.ts'

const noWriteOperator: OperatorPort = {
  async executeConfirmed() {
    throw new Error('Unexpected operator write')
  },
}

/** Test the real correction entry against an already completed SDK review in this sandbox. */
export async function exerciseNativeDispositionBoundary(
  cwd: string,
  driver: ReviewDriver,
  fault: 'original-history' | 'foreign-synthesis',
): Promise<object> {
  const pull = { repository: REVIEW_SCOPE.repository, target: 'acme/app#7' }
  const options = { cwd, readAuthor: 'operator', writeAuthor: 'operator', writerLogin: 'operator', gh: defaultGh }
  const readHistory = async () => decodeHistory(await readGitHubHistory(pull, options))
  const history = await readHistory()
  const review = history.operations.flatMap((item) => (item.record?.kind === 'review' ? [item.record] : [])).at(-1)
  if (!review) throw new Error('Native completed review is missing')
  const decision = history.operations.find((item) => item.recordId === review.payload.decisionId)?.record
  if (decision?.kind !== 'decision') throw new Error('Native review decision is missing')
  const synthesis = history.operations.find((item) => item.recordId === decision.payload.originalContributionId)?.record
  if (synthesis?.kind !== 'contribution' || synthesis.payload.inventoryId === null)
    throw new Error('Native synthesis contribution is missing')
  const panels = history.operations.flatMap((item) =>
    item.record?.kind === 'contribution' && item.record.payload.host.phase === 'panel' ? [item.record] : [],
  )
  if (panels.length === 0) throw new Error('Native panel findings are missing')
  const resolver = createResolver(cwd, defaultGh, REVIEW_SCOPE.repository)
  const target = await resolver.resolveExplicit('7')
  if (!target) throw new Error('Native PR target is missing')
  const binding = await resolvePublishBinding(cwd, defaultGh, REVIEW_SCOPE.repository, target)
  if (!binding.ok) throw new Error(`Native publish binding refused: ${binding.diagnostics.join(',')}`)
  const operations = await createInstalledUwOperations({ cwd, operator: noWriteOperator, readAuthor: 'operator' })
  const rawPublisher = createGitHubRecordPublisher(pull, options, null)
  const publisher: RecordPublisher = {
    async publish(record, canPublish) {
      const original = decodeHistory(await readGitHubHistory(REVIEW_SCOPE, options))
      const saved = await rawPublisher.publish(record, [original], canPublish)
      return saved.ok ? { ok: true, value: undefined } : saved
    },
  }
  const identity = createIdentity()
  const prepared = await prepareReviewBoundFix(
    {
      cwd,
      reference: '7',
      contextTarget: target,
      rawOperatorRequest: null,
      scope: 'Fix the reviewed finding',
      reviewId: review.recordId,
      candidateGitSHA: target.candidateGitSHA ?? undefined,
      policy: decision.payload.judgment.policy,
      identity,
      publishBinding: binding.value,
      nativeTasks: [],
      operations,
      uw: REVIEW_SCOPE,
    },
    resolver,
    publisher,
    { nextReviewStep },
  )
  if (!prepared.ok) throw new Error(`Native review-bound preparation refused: ${prepared.diagnostics.join(',')}`)
  const actual = createFixDispositionStore(REVIEW_SCOPE, options)
  const source = { kind: 'decision' as const, decision }
  const baseline = await captureDispositionSource(prepared.value.causeContext, source, actual)
  if (!baseline.ok) throw new Error(`Native producer baseline refused: ${baseline.diagnostics.join(',')}`)
  const nativeRead = await operations.readUw(REVIEW_SCOPE)
  if (nativeRead.accepted.status !== 'accepted') throw new Error('Native original UW is not accepted')
  const requested: Array<readonly { repository: string; target: string }[]> = []
  let catalogueCalls = 0
  let dispositionPublishes = 0
  let correctionPublishes = 0
  let activations = 0
  let batches = 0
  let starts = 0
  const unavailable = createFixDispositionStore(REVIEW_SCOPE, {
    ...options,
    gh: async (workdir, args) => {
      if (args[0] === 'api' && args[1]?.startsWith(`repos/${REVIEW_SCOPE.repository}/issues/42/comments?`))
        throw new Error('Injected original comment transport failure')
      return defaultGh(workdir, args)
    },
  })
  const store = {
    async read(scopes: readonly { repository: string; target: string }[]) {
      requested.push(scopes)
      const result = await (fault === 'original-history' ? unavailable : actual).read(scopes)
      if (!result.ok || fault !== 'foreign-synthesis') return result
      return {
        ok: true as const,
        value: result.value.map((item) =>
          item.source.scope.repository === pull.repository && item.source.scope.target === pull.target
            ? {
                ...item,
                operations: item.operations.map((operation) =>
                  operation.recordId === synthesis.payload.inventoryId
                    ? { ...operation, authority: 'foreign' as const }
                    : operation,
                ),
              }
            : item,
        ),
      }
    },
    async catalogues(histories: Parameters<typeof actual.catalogues>[0]) {
      catalogueCalls += 1
      return actual.catalogues(histories)
    },
    async publish(...args: Parameters<typeof actual.publish>) {
      dispositionPublishes += 1
      return actual.publish(...args)
    },
  }
  const native: NativePort = {
    ...driver.native,
    activate(...args) {
      activations += 1
      return driver.native.activate(...args)
    },
  }
  const trackedPublisher: RecordPublisher = {
    async publish(record, canPublish) {
      correctionPublishes += 1
      return publisher.publish(record, canPublish)
    },
  }
  const product = {
    github: options,
    dispositionStore: store,
    publisher: trackedPublisher,
    native,
    runtime: {
      signal: new AbortController().signal,
      uw: operations,
      onBatch() {
        batches += 1
      },
      onStarted() {
        starts += 1
      },
    },
    readHistory,
  }
  const result =
    fault === 'original-history'
      ? await executeDecision(prepared.value, decision, product, identity, 'authenticate-source')
      : await runReviewBoundFixWorkflow(prepared.value, decision, product, identity)
  const after = await readHistory()
  return {
    baseline,
    result,
    requested,
    catalogueCalls,
    dispositionPublishes,
    correctionPublishes,
    activations,
    batches,
    starts,
    panels,
    after,
  }
}
