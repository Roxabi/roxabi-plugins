import { isDeepStrictEqual } from 'node:util'
import type { Result } from '../engine/result.ts'
import { seedEvidenceObservation } from './uw-action-basis.ts'
import type { CurrentActionFacts, UwActionRequest } from './uw-action-contract.ts'
import { uwFacts } from './uw-action-fact-parts.ts'
import { type ActionFactSource, configuration, observeCode, readHistories } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import { standaloneFacts } from './uw-action-standalone-facts.ts'

/** One observation cut for common review actions; selection remains per action. */
export async function readProductionActionFactsBatch(
  requests: readonly UwActionRequest[],
  source: ActionFactSource,
  reviewedFingerprint?: string,
): Promise<Result<readonly { actionId: string; facts: CurrentActionFacts }[]>> {
  const first = requests[0]
  if (first === undefined) return { ok: true, value: [] }
  const { actionId: _firstId, ...common } = first
  if (
    first.purpose !== 'review' ||
    requests.some(({ actionId: _id, ...request }) => !isDeepStrictEqual(request, common))
  )
    return actionFailure('action-input-missing', 'Batch requires common review requests differing only by action ID')

  const observed = await observeCode(first, source).catch((error: unknown) =>
    actionFailure('action-code-moved', error instanceof Error ? error.message : 'code observation failed'),
  )
  if (!observed.ok) return observed
  const config = await configuration(source.cwd, first.code.referenceCommit)
  if (!config.ok) return config
  const subject = first.subject
  const scopes =
    subject.kind === 'standalone-pr'
      ? [subject.pullRequest]
      : subject.pullRequest === null
        ? [subject.uw]
        : [subject.uw, subject.pullRequest]
  const histories = await readHistories(scopes, source)
  if (!histories.ok) return histories
  const evidence = seedEvidenceObservation(histories.value)

  const facts: { actionId: string; facts: CurrentActionFacts }[] = []
  for (const request of requests) {
    const result =
      request.subject.kind === 'standalone-pr'
        ? await standaloneFacts(request, source, observed.value, config.value, reviewedFingerprint, histories.value)
        : await uwFacts(request, source, observed.value, config.value, reviewedFingerprint, histories.value, evidence)
    if (!result.ok) return result
    facts.push({ actionId: request.actionId, facts: result.value })
  }
  return { ok: true, value: facts }
}
