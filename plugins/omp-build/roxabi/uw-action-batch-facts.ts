import { isDeepStrictEqual } from 'node:util'
import { readCauseHistoryClosure, readComposedWorkflowHistory } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { type CausalFactObservation, type ObserveCausalFacts, seedEvidenceObservation } from './uw-action-basis.ts'
import type { CurrentActionFacts, ReviewRootRef, UwActionRequest } from './uw-action-contract.ts'
import { uwFacts } from './uw-action-fact-parts.ts'
import { type ActionFactSource, configuration, observeCode, readHistories } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import { standaloneFacts } from './uw-action-standalone-facts.ts'
import { readReviewInputHistories } from './uw-input-readers.ts'

function requiredScopes(requests: readonly UwActionRequest[], reviewedRoot?: ReviewRootRef): Scope[] {
  const scopes = new Map<string, Scope>()
  const add = (scope: Scope) => scopes.set(JSON.stringify([scope.repository, scope.target]), scope)
  for (const request of requests) {
    if (request.subject.kind === 'uw') {
      add(request.subject.uw)
      if (request.subject.binding !== null) add(request.subject.binding.record.scope)
      if (request.subject.pullRequest !== null) add(request.subject.pullRequest)
    } else add(request.subject.pullRequest)
    for (const ref of request.stageSources) add(ref.record.scope)
    for (const ref of request.expandedContext) if (ref.source === 'record') add(ref.record.scope)
  }
  if (reviewedRoot !== undefined) add(reviewedRoot.scope)
  return [...scopes.values()]
}

function primaryHistories(
  request: UwActionRequest,
  primary: readonly DecodedHistory[],
): Result<Map<string, DecodedHistory>> {
  const subject = request.subject
  const scopes =
    subject.kind === 'standalone-pr'
      ? [subject.pullRequest]
      : subject.pullRequest === null
        ? [subject.uw]
        : [subject.uw, subject.pullRequest]
  const expected = new Set(scopes.map((scope) => JSON.stringify([scope.repository, scope.target])))
  const selected = new Map<string, DecodedHistory>()
  for (const history of primary) {
    const scope = history.source.scope
    const key = JSON.stringify([scope.repository, scope.target])
    if (!expected.delete(key) || selected.has(key) || !history.source.complete)
      return actionFailure('record-unreadable', 'Primary action histories are unexpected, duplicate, or incomplete')
    selected.set(key, history)
  }
  if (expected.size > 0) return actionFailure('record-unreadable', 'Primary action history is missing')
  return { ok: true, value: selected }
}

async function readUwCausalHistories(
  selected: Map<string, DecodedHistory>,
  required: readonly Scope[],
  source: ActionFactSource,
): Promise<Result<readonly DecodedHistory[]>> {
  const missing = required.filter((scope) => !selected.has(JSON.stringify([scope.repository, scope.target])))
  if (missing.length > 0) {
    const fetched = await readComposedWorkflowHistory(missing, source)
    if (!fetched.ok) return { ok: false, diagnostics: fetched.diagnostics }
    const expected = new Set(missing.map((scope) => JSON.stringify([scope.repository, scope.target])))
    for (const history of fetched.histories) {
      const scope = history.source.scope
      const key = JSON.stringify([scope.repository, scope.target])
      if (!expected.delete(key) || !history.source.complete)
        return actionFailure('record-unreadable', 'Required action history is unexpected, duplicate, or incomplete')
      selected.set(key, history)
    }
    if (expected.size > 0) return actionFailure('record-unreadable', 'Required action history is missing')
  }
  const closure = await readCauseHistoryClosure([...selected.values()], (scopes) =>
    readComposedWorkflowHistory(scopes, source),
  )
  return closure.ok ? { ok: true, value: closure.histories } : { ok: false, diagnostics: closure.diagnostics }
}

async function readStandaloneCausalHistories(
  scope: Scope,
  selected: ReadonlyMap<string, DecodedHistory>,
  required: readonly Scope[],
  source: ActionFactSource,
): Promise<Result<readonly DecodedHistory[]>> {
  const root = selected.get(JSON.stringify([scope.repository, scope.target]))
  if (root === undefined) return actionFailure('record-unreadable', 'Standalone pull request history is absent')
  const external = await readReviewInputHistories(root, source, required)
  return external.ok ? { ok: true, value: [root, ...external.value] } : external
}

async function buildCausalFacts(
  first: UwActionRequest,
  primary: readonly DecodedHistory[],
  required: readonly Scope[],
  source: ActionFactSource,
): Promise<Result<CausalFactObservation>> {
  const selected = primaryHistories(first, primary)
  if (!selected.ok) return selected
  const observed =
    first.subject.kind === 'standalone-pr'
      ? await readStandaloneCausalHistories(first.subject.pullRequest, selected.value, required, source)
      : await readUwCausalHistories(selected.value, required, source)
  if (!observed.ok) return observed
  const histories = observed.value
  const catalogues = await loadReviewClassCatalogues({ histories, cwd: source.cwd, gh: source.gh })
  return { ok: true, value: { causal: { histories, catalogues }, evidence: seedEvidenceObservation(histories) } }
}

function observedCausalFacts(
  requests: readonly UwActionRequest[],
  primary: readonly DecodedHistory[],
  source: ActionFactSource,
  reviewedRoot?: ReviewRootRef,
): ObserveCausalFacts {
  const required = requiredScopes(requests, reviewedRoot)
  let observation: Promise<Result<CausalFactObservation>> | undefined
  return () => {
    const first = requests[0]
    if (first === undefined)
      return Promise.resolve(actionFailure('action-input-missing', 'Review action batch is empty'))
    if (observation === undefined) observation = buildCausalFacts(first, primary, required, source)
    return observation
  }
}

/** One observation cut for common review actions; selection remains per action. */
export async function readProductionActionFactsBatch(
  requests: readonly UwActionRequest[],
  source: ActionFactSource,
  reviewedFingerprint?: string,
  reviewedRoot?: ReviewRootRef,
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
  const observeCausal = observedCausalFacts(requests, histories.value, source, reviewedRoot)

  const facts: { actionId: string; facts: CurrentActionFacts }[] = []
  for (const request of requests) {
    const result =
      request.subject.kind === 'standalone-pr'
        ? await standaloneFacts(
            request,
            source,
            observed.value,
            config.value,
            reviewedFingerprint,
            histories.value,
            reviewedRoot,
            observeCausal,
          )
        : await uwFacts(
            request,
            source,
            observed.value,
            config.value,
            reviewedFingerprint,
            histories.value,
            observeCausal,
            reviewedRoot,
          )
    if (!result.ok) return result
    facts.push({ actionId: request.actionId, facts: result.value })
  }
  return { ok: true, value: facts }
}
