import type { DecodedHistory } from '../../engine/history-schema.ts'
import { equalScope } from '../../engine/record-diagnostics.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Diagnostic, Json, Scope } from '../../engine/record-values.ts'
import { historyFor, workflowOperationProblem } from '../../engine/workflow-control.ts'
import {
  confirmedAccountedMandate,
  selectWorkflowBinding,
  type WorkflowBindingSelection,
} from '../../engine/workflow-pr-binding.ts'
import { refKey } from '../../engine/workflow-pr-binding-chain.ts'
import { decodeHistory } from '../github/history-codec.ts'
import { readGitHubHistory } from '../github/transport.ts'
import { diagnostic, type GitHubOptions } from '../github/types.ts'
import { scopeNumber } from '../github-native/issue-facts.ts'
import { readNativePullRequestFacts } from './native-facts.ts'
import type { WorkflowBindingRead } from './types.ts'

type NativePullRequestFacts = { branch: string; base: string; head: string; baseTip: string }
type BoundSelection = Extract<WorkflowBindingSelection, { status: 'bound' }>

export type InitialBindingResolution =
  | {
      ok: true
      pullRequest: NativePullRequestFacts
      prHistory: DecodedHistory
      mandateHistories: DecodedHistory[]
      selected: BoundSelection
    }
  | { ok: false; result: WorkflowBindingRead }

export type ParentMandateResolution =
  | { ok: true; parentScopes: Scope[]; parentHistories: DecodedHistory[] }
  | { ok: false; result: WorkflowBindingRead }

export function bindingRefusal(
  status: 'absent' | 'partial' | 'conflicting' | 'unconfirmed' | 'incomplete' | 'incompatible-format' | 'unreadable',
  diagnostics: Diagnostic[],
  evidence?: Json,
): WorkflowBindingRead {
  return evidence === undefined
    ? { ok: false, status, reason: status, diagnostics }
    : { ok: false, status, reason: status, diagnostics, evidence }
}

type BindingMandateHistories = { ok: true; histories: DecodedHistory[] } | { ok: false; result: WorkflowBindingRead }

function initialBindingSelection(
  prScope: Scope,
  prHistory: DecodedHistory,
  mandateHistories: readonly DecodedHistory[],
  pullRequest: NativePullRequestFacts,
): WorkflowBindingSelection {
  return selectWorkflowBinding({
    pullRequest: prScope,
    histories: [prHistory, ...mandateHistories],
    native: { branch: pullRequest.branch, base: pullRequest.base },
  })
}

async function readBindingMandateHistories(
  prHistory: DecodedHistory,
  options: GitHubOptions,
): Promise<BindingMandateHistories> {
  const histories: DecodedHistory[] = []
  for (const operation of prHistory.operations) {
    const record = operation.record
    if (record?.kind !== 'workflow-binding') continue

    const mandateScope = record.payload.mandate.scope
    if (historyFor(mandateScope, [prHistory, ...histories]) !== null) continue

    const history = decodeHistory(await readGitHubHistory(mandateScope, options))
    if (!history.source.complete) {
      return {
        ok: false,
        result: bindingRefusal('incomplete', [diagnostic('incomplete', 'Binding mandate history is incomplete')]),
      }
    }
    histories.push(history)
  }
  return { ok: true, histories }
}

export async function resolveInitialWorkflowBinding(
  prScope: Scope,
  options: GitHubOptions,
): Promise<InitialBindingResolution> {
  const pr = scopeNumber(prScope)
  const pullRequest = await readNativePullRequestFacts(prScope.repository, pr, options)
  const prHistory = decodeHistory(await readGitHubHistory(prScope, options))
  if (!prHistory.source.complete) {
    return { ok: false, result: bindingRefusal('incomplete', [diagnostic('incomplete', 'PR history is incomplete')]) }
  }

  let mandateHistories: DecodedHistory[] = []
  let selected = initialBindingSelection(prScope, prHistory, mandateHistories, pullRequest)
  if (selected.status === 'incomplete') {
    const fetched = await readBindingMandateHistories(prHistory, options)
    if (!fetched.ok) return { ok: false, result: fetched.result }
    mandateHistories = fetched.histories
    selected = initialBindingSelection(prScope, prHistory, mandateHistories, pullRequest)
  }

  if (selected.status !== 'bound') {
    return {
      ok: false,
      result: bindingRefusal(
        selected.status,
        selected.status === 'absent' ? [diagnostic('absent', 'PR has no workflow-binding')] : selected.diagnostics,
      ),
    }
  }
  return { ok: true, pullRequest, prHistory, mandateHistories, selected }
}

export async function readParentMandateChain(
  mandate: Extract<CanonicalRecord, { kind: 'mandate' }>,
  knownHistories: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<ParentMandateResolution> {
  const parentScopes: Scope[] = []
  const parentHistories: DecodedHistory[] = []
  const seenParents = new Set<string>()
  let parent = mandate.payload.parent
  while (parent !== null) {
    if (parent.kind !== 'mandate') {
      return {
        ok: false,
        result: bindingRefusal('conflicting', [diagnostic('kind-mismatch', 'Mandate parent is not a mandate')]),
      }
    }
    const key = refKey(parent)
    if (seenParents.has(key)) {
      return {
        ok: false,
        result: bindingRefusal('conflicting', [diagnostic('conflicting', 'Mandate parent chain cycles')]),
      }
    }
    seenParents.add(key)

    let parentHistory = historyFor(parent.scope, [...knownHistories, ...parentHistories])
    if (parentHistory === null) {
      parentHistory = decodeHistory(await readGitHubHistory(parent.scope, options))
      if (!parentHistory.source.complete) {
        return {
          ok: false,
          result: bindingRefusal('incomplete', [diagnostic('incomplete', 'Parent mandate history is incomplete')]),
        }
      }
      parentHistories.push(parentHistory)
    }
    if (workflowOperationProblem(parentHistory) === 'incompatible-format') {
      const formatDiagnostic = parentHistory.diagnostics.find((entry) => entry.code === 'incompatible-format')
      return {
        ok: false,
        result: bindingRefusal('incompatible-format', [
          formatDiagnostic ?? diagnostic('incompatible-format', 'Parent mandate uses an incompatible format'),
        ]),
      }
    }

    const parentRecord = confirmedAccountedMandate(parentHistory, parent)
    if (parentRecord === null) {
      return {
        ok: false,
        result: bindingRefusal('incomplete', [diagnostic('incomplete', 'Parent mandate record is not confirmed')]),
      }
    }
    parentScopes.push(parent.scope)
    parent = parentRecord.payload.parent
  }
  return { ok: true, parentScopes, parentHistories }
}

export function uniqueHistories(histories: readonly DecodedHistory[]): DecodedHistory[] {
  const unique: DecodedHistory[] = []
  for (const history of histories) {
    if (unique.some((existing) => equalScope(existing.source.scope, history.source.scope))) continue
    unique.push(history)
  }
  return unique
}
