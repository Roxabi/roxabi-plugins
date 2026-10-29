import { selectWorkflowBinding } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import { assertCurrentOutputClosure, currentRootOutputRefs } from './uw-action-closure.ts'
import type { ActionInputManifest, CurrentActionFacts, UwActionRequest } from './uw-action-contract.ts'
import { expansionOrigin } from './uw-action-expansion-origin.ts'
import { type ActionFactSource, readHistories } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'

export async function standaloneFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  observed: { branch: string; baseName: string },
  config: ActionInputManifest['configuration'],
  reviewedFingerprint?: string,
  histories?: readonly DecodedHistory[],
): Promise<Result<CurrentActionFacts>> {
  if (request.subject.kind !== 'standalone-pr')
    return actionFailure('action-input-missing', 'Standalone subject is absent')
  const read =
    histories === undefined
      ? await readHistories([request.subject.pullRequest], source)
      : { ok: true as const, value: histories }
  if (!read.ok) return read
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
  if (root !== undefined) {
    const closed = assertCurrentOutputClosure(request, read.value, [], reviewedFingerprint, root)
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
      currentOutputs: currentRootOutputRefs(request, read.value, reviewedFingerprint, root),
      configuration: config,
      ...(expansion.value?.previous === undefined ? {} : { expansionPrevious: expansion.value.previous }),
    },
  }
}
