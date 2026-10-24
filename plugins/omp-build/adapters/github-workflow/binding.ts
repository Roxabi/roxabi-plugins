import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { RecordProjectionConfig } from '../../engine/result.ts'
import { publishGitHubRecord } from '../github/publish.ts'
import { GitHubHistoryReadError, type GitHubOptions } from '../github/types.ts'
import {
  bindingRefusal,
  historyFor,
  readParentMandateChain,
  resolveInitialWorkflowBinding,
  uniqueHistories,
} from './binding-resolution.ts'
import { readScopeIssueBody } from './native-facts.ts'
import { diagnostic, type LandingFactsRead, type WorkflowBindingRead, type WorkflowPublication } from './types.ts'

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

    let body: string
    try {
      body = await readScopeIssueBody(selected.mandate.scope, options)
    } catch (error) {
      const diagnostics =
        error instanceof GitHubHistoryReadError
          ? error.diagnostics
          : [diagnostic('unreadable', error instanceof Error ? error.message : String(error))]
      return bindingRefusal('unreadable', diagnostics, { scope: selected.mandate.scope })
    }

    return {
      ok: true,
      value: {
        binding: selected.binding,
        history: mandateHistory,
        histories: uniqueHistories([prHistory, ...mandateHistories, ...parentResolution.parentHistories]),
        linkedIssueBodies: [{ scope: selected.mandate.scope, body }],
        parentScopes: parentResolution.parentScopes,
        native: {
          branch: pullRequest.branch,
          base: pullRequest.base,
          pullRequest: prScope,
          linkedIssueScopes: [selected.mandate.scope],
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

  return {
    ok: true,
    histories: bound.value.histories,
    native: bound.value.native,
    observed: bound.value.observed,
    linkedIssueBodies: bound.value.linkedIssueBodies,
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
