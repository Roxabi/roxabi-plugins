import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic, Scope } from '../../engine/record-values.ts'
import type { ReviewClassCatalogues } from '../../engine/review-class-catalogue.ts'
import { historyFor } from '../../engine/workflow-control.ts'
import type { PublicationContextResolver } from '../github/publication-context.ts'
import { publishGitHubRecord } from '../github/publish.ts'
import { diagnostic, GitHubHistoryReadError, type GitHubOptions } from '../github/types.ts'
import { readUwGraph } from '../github-native/uw-graph.ts'
import {
  bindingRefusal,
  readParentMandateChain,
  resolveInitialWorkflowBinding,
  uniqueHistories,
} from './binding-resolution.ts'
import type { LandingFactsRead, WorkflowBindingRead, WorkflowPublication } from './types.ts'
import { readUwCompletionObservation } from './uw-observation.ts'

/**
 * Confirmed PR workflow-binding via selectWorkflowBinding, then explicit parent
 * history expansion. closingIssuesReferences is not authority. Tracker parentage
 * is not authority. Zero claims are absent. A present invalid claim is never absent.
 */
type BoundWorkflow = Omit<Extract<WorkflowBindingRead, { ok: true }>['value'], 'uwGraph'> & { root: Scope }

async function readBoundWorkflow(
  prScope: Scope,
  options: GitHubOptions,
): Promise<{ ok: true; value: BoundWorkflow } | Extract<WorkflowBindingRead, { ok: false }>> {
  try {
    const resolved = await resolveInitialWorkflowBinding(prScope, options)
    if (!resolved.ok) return resolved.result

    const { pullRequest, prHistory, mandateHistories, selected } = resolved
    const mandateHistory = historyFor(selected.mandate.scope, [prHistory, ...mandateHistories])
    if (mandateHistory === null) {
      return bindingRefusal('incomplete', [diagnostic('incomplete', 'Binding mandate history is missing')])
    }

    const parentResolution = await readParentMandateChain(
      selected.mandateRecord,
      [prHistory, ...mandateHistories],
      options,
    )
    if (!parentResolution.ok) return parentResolution.result

    return {
      ok: true,
      value: {
        binding: selected.binding,
        history: mandateHistory,
        histories: uniqueHistories([prHistory, ...mandateHistories, ...parentResolution.parentHistories]),
        root: selected.mandateRecord.payload.ownSpec.uw,
        parentScopes: parentResolution.parentScopes,
        native: {
          branch: pullRequest.branch,
          base: pullRequest.base,
          pullRequest: prScope,
          linkedIssueScopes: [selected.mandateRecord.payload.ownSpec.uw],
        },
        observed: { head: pullRequest.head, baseTip: pullRequest.baseTip },
      },
    }
  } catch (error) {
    const diagnostics =
      error instanceof GitHubHistoryReadError
        ? error.diagnostics
        : [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))]
    return bindingRefusal('unreadable', diagnostics)
  }
}

export async function readWorkflowBinding(prScope: Scope, options: GitHubOptions): Promise<WorkflowBindingRead> {
  const bound = await readBoundWorkflow(prScope, options)
  if (!bound.ok) return bound
  const { root, ...value } = bound.value
  try {
    return { ok: true, value: { ...value, uwGraph: await readUwGraph(root, options) } }
  } catch (error) {
    const diagnostics =
      error instanceof GitHubHistoryReadError
        ? error.diagnostics
        : [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))]
    return bindingRefusal('unreadable', diagnostics)
  }
}

function scopeKey(scope: Scope): string {
  return `${scope.repository}\0${scope.target}`
}

function mergeObservedHistories(
  known: readonly DecodedHistory[],
  observed: readonly DecodedHistory[],
): { ok: true; histories: DecodedHistory[] } | { ok: false; diagnostics: Diagnostic[] } {
  const histories = new Map<string, DecodedHistory>()
  for (const history of [...known, ...observed]) {
    const key = scopeKey(history.source.scope)
    const existing = histories.get(key)
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(history)) {
      return {
        ok: false,
        diagnostics: [
          diagnostic(
            'conflicting',
            `Workflow history for ${history.source.scope.target} changed during landing observation`,
          ),
        ],
      }
    }
    histories.set(key, history)
  }
  return { ok: true, histories: [...histories.values()] }
}

/**
 * Cold landing read. Admission is the confirmed workflow-binding, then its
 * mandate and explicit parent refs. Native closing links are not authority.
 */
export async function readLandingFacts(
  prScope: Scope,
  options: GitHubOptions,
  loadCatalogues: (histories: readonly DecodedHistory[]) => Promise<ReviewClassCatalogues>,
): Promise<LandingFactsRead> {
  const bound = await readBoundWorkflow(prScope, options)
  if (!bound.ok) {
    return {
      ok: false,
      reason: bound.reason === 'unconfirmed' ? 'unconfirmed' : bound.reason,
      diagnostics: bound.diagnostics,
      evidence: bound.evidence,
    }
  }

  const observation = await readUwCompletionObservation(bound.value.root, options, async (histories) => {
    const merged = mergeObservedHistories(bound.value.histories, histories)
    return loadCatalogues(merged.ok ? merged.histories : histories)
  })
  const merged = mergeObservedHistories(bound.value.histories, observation.histories)
  if (!merged.ok) return { ok: false, reason: 'conflicting', diagnostics: merged.diagnostics }
  return {
    ok: true,
    histories: merged.histories,
    authorityHistories: bound.value.histories,
    catalogues: observation.catalogues,
    native: bound.value.native,
    observed: bound.value.observed,
    uwGraph: observation.graph,
    observation: { ...observation, histories: merged.histories },
    parentScopes: bound.value.parentScopes,
    binding: bound.value.binding,
  }
}

/**
 * Publish a workflow record through the canonical codec/publisher only.
 * Supplies externalHistories to projection/ref validation. Publication confirms
 * record refs and read-back; it does not authorize the next action. Confirmed
 * read-back is required; uncertain/refused never mint a checkpoint. Partial
 * same-operation resume semantics are preserved by publishGitHubRecord.
 */
export async function publishConfirmedWorkflowRecord(
  record: CanonicalRecord,
  options: GitHubOptions,
  resolveContext: PublicationContextResolver,
  externalHistories: readonly DecodedHistory[] = [],
): Promise<WorkflowPublication> {
  return publishGitHubRecord(record, options, resolveContext, externalHistories)
}
