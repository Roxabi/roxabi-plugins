import { historyFor, selectWorkflowBinding } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import type { ObserveCausalFacts } from './uw-action-basis.ts'
import { assertCurrentOutputClosure, currentRootOutputRefs, type VerifiedExpansionRoot } from './uw-action-closure.ts'
import type { ActionInputManifest, CurrentActionFacts, ReviewRootRef, UwActionRequest } from './uw-action-contract.ts'
import { expansionOrigin } from './uw-action-expansion-origin.ts'
import { type ActionFactSource, readHistories } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import { authenticateReviewRoot } from './uw-action-review-root.ts'
import { readReviewInputHistories } from './uw-input-readers.ts'

async function confirmStandaloneOutputClosure(
  request: UwActionRequest,
  scope: Scope,
  histories: readonly DecodedHistory[],
  source: ActionFactSource,
  reviewedRoot?: ReviewRootRef,
  root?: VerifiedExpansionRoot,
  observeCausal?: ObserveCausalFacts,
): Promise<Result<true>> {
  const history = historyFor(scope, histories)
  if (history === null) return actionFailure('record-unreadable', 'Standalone pull request history is absent')
  if (observeCausal !== undefined) {
    const observed = await observeCausal()
    if (!observed.ok) return observed
    return assertCurrentOutputClosure(
      request,
      observed.value.causal.histories,
      observed.value.causal.catalogues,
      [],
      reviewedRoot,
      root,
    )
  }
  const external = await readReviewInputHistories(history, source)
  if (!external.ok) return external
  const completeHistories = [history, ...external.value]
  const catalogues = await loadReviewClassCatalogues({ histories: completeHistories, cwd: source.cwd, gh: source.gh })
  return assertCurrentOutputClosure(request, completeHistories, catalogues, [], reviewedRoot, root)
}

export async function standaloneFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  observed: { branch: string; baseName: string },
  config: ActionInputManifest['configuration'],
  reviewedFingerprint?: string,
  histories?: readonly DecodedHistory[],
  reviewedRoot?: ReviewRootRef,
  observeCausal?: ObserveCausalFacts,
): Promise<Result<CurrentActionFacts>> {
  if (request.subject.kind !== 'standalone-pr')
    return actionFailure('action-input-missing', 'Standalone subject is absent')
  const read =
    histories === undefined
      ? await readHistories([request.subject.pullRequest], source)
      : { ok: true as const, value: histories }
  if (!read.ok) return read
  const authenticated = authenticateReviewRoot(request, read.value, reviewedFingerprint, reviewedRoot)
  if (!authenticated.ok) return authenticated
  const selected = selectWorkflowBinding({
    pullRequest: request.subject.pullRequest,
    histories: read.value,
    native: { branch: observed.branch, base: observed.baseName },
  })
  if (selected.status === 'bound')
    return actionFailure('action-input-missing', 'Standalone review has an approved workflow binding')
  const expansion = expansionOrigin(request, read.value, reviewedFingerprint)
  if (!expansion.ok) return expansion
  const root = expansion.value?.root
  if (root !== undefined || reviewedRoot !== undefined) {
    const closed = await confirmStandaloneOutputClosure(
      request,
      request.subject.pullRequest,
      read.value,
      source,
      reviewedRoot,
      root,
      observeCausal,
    )
    if (!closed.ok) return closed
  }
  return {
    ok: true,
    value: {
      spec: { kind: 'absent', reason: 'standalone-review' },
      subject: request.subject,
      acceptedSources: [],
      deliveryData: [],
      plannedPaths: [],
      currentOutputs: currentRootOutputRefs(request, read.value, reviewedRoot, root),
      configuration: config,
      ...(expansion.value?.previous === undefined ? {} : { expansionPrevious: expansion.value.previous }),
    },
  }
}
