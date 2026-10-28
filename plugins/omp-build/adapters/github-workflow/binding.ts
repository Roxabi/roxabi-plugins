import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic, Scope } from '../../engine/record-values.ts'
import type { RecordProjectionConfig } from '../../engine/result.ts'
import { historyFor } from '../../engine/workflow-control.ts'
import { publishGitHubRecord } from '../github/publish.ts'
import { diagnostic, GitHubHistoryReadError, type GitHubOptions } from '../github/types.ts'
import { readUwGraph } from '../github-native/uw-graph.ts'
import {
  bindingRefusal,
  readParentMandateChain,
  resolveInitialWorkflowBinding,
  uniqueHistories,
} from './binding-resolution.ts'
import { readComposedWorkflowHistory, validateComposedWorkflowHistories } from './history.ts'
import type { LandingFactsRead, WorkflowBindingRead, WorkflowPublication } from './types.ts'

/**
 * Confirmed PR workflow-binding via selectWorkflowBinding, then explicit parent
 * history expansion. closingIssuesReferences is not authority. Tracker parentage
 * is not authority. Zero claims are absent. A present invalid claim is never absent.
 */
export async function readWorkflowBinding(prScope: Scope, options: GitHubOptions): Promise<WorkflowBindingRead> {
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

    const uwGraph = await readUwGraph(selected.mandateRecord.payload.ownSpec.uw, options)

    return {
      ok: true,
      value: {
        binding: selected.binding,
        history: mandateHistory,
        histories: uniqueHistories([prHistory, ...mandateHistories, ...parentResolution.parentHistories]),
        uwGraph,
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

function graphHistoryScopes(
  graph: Extract<WorkflowBindingRead, { ok: true }>['value']['uwGraph'],
): { ok: true; scopes: Scope[] } | { ok: false; diagnostics: Diagnostic[] } {
  const scopes = new Map<string, (typeof graph)['nodes'][number]>()
  for (const node of graph.nodes) {
    const key = scopeKey(node.uw)
    const existing = scopes.get(key)
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(node)) {
      return {
        ok: false,
        diagnostics: [diagnostic('conflicting', `Native UW graph has conflicting observations for ${node.uw.target}`)],
      }
    }
    scopes.set(key, node)
  }
  return { ok: true, scopes: [...scopes.values()].map((node) => node.uw) }
}

function landingRefusal(
  reason: Extract<LandingFactsRead, { ok: false }>['reason'],
  diagnostics: Diagnostic[],
): Extract<LandingFactsRead, { ok: false }> {
  return { ok: false, reason, diagnostics }
}

async function completeLandingHistories(
  bound: Extract<WorkflowBindingRead, { ok: true }>['value'],
  options: GitHubOptions,
): Promise<{ ok: true; histories: DecodedHistory[] } | Extract<LandingFactsRead, { ok: false }>> {
  if (bound.uwGraph.status !== 'complete') return { ok: true, histories: bound.histories }
  const graphScopes = graphHistoryScopes(bound.uwGraph)
  if (!graphScopes.ok) return landingRefusal('conflicting', graphScopes.diagnostics)
  const known = new Set(bound.histories.map((history) => scopeKey(history.source.scope)))
  const scopes = graphScopes.scopes.filter((scope) => !known.has(scopeKey(scope)))
  if (scopes.length === 0) return { ok: true, histories: bound.histories }
  const composed = await readComposedWorkflowHistory(scopes, options)
  if (!composed.ok) return landingRefusal(composed.reason, composed.diagnostics)
  const merged = mergeObservedHistories(bound.histories, composed.histories)
  if (!merged.ok) return landingRefusal('conflicting', merged.diagnostics)
  const validated = validateComposedWorkflowHistories(merged.histories)
  return validated.ok ? merged : landingRefusal(validated.reason, validated.diagnostics)
}

/**
 * Cold landing read. Admission is the confirmed workflow-binding, then its
 * mandate and explicit parent refs. Native closing links are not authority.
 */
export async function readLandingFacts(prScope: Scope, options: GitHubOptions): Promise<LandingFactsRead> {
  const bound = await readWorkflowBinding(prScope, options)
  if (!bound.ok) {
    return {
      ok: false,
      reason: bound.reason === 'unconfirmed' ? 'unconfirmed' : bound.reason,
      diagnostics: bound.diagnostics,
      evidence: bound.evidence,
    }
  }

  const complete = await completeLandingHistories(bound.value, options)
  if (!complete.ok) return complete
  return {
    ok: true,
    histories: complete.histories,
    native: bound.value.native,
    observed: bound.value.observed,
    uwGraph: bound.value.uwGraph,
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
  history: DecodedHistory,
  options: GitHubOptions,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[] = [],
): Promise<WorkflowPublication> {
  return publishGitHubRecord(record, history, options, config, externalHistories)
}
