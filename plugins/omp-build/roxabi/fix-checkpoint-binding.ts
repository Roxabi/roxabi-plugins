import type { DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import { readNativePullRequestFacts, readWorkflowBinding } from '../dist/contracts.js'
import { liveBoundSpec } from './fix-checkpoint-state.ts'
import type { FixActionResult, FixTarget } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { externalRef, objectValue } from './fix-mandate-types.ts'

export function liveNativeBranch(value: unknown): { branch: string; base: string } | null {
  const native = objectValue(objectValue(value)?.native)
  if (
    native === null ||
    typeof native.branch !== 'string' ||
    native.branch.length === 0 ||
    typeof native.base !== 'string' ||
    native.base.length === 0
  ) {
    return null
  }
  return { branch: native.branch, base: native.base }
}

export async function linkedIssueBinding(
  target: FixTarget,
  options: GitHubOptions,
): Promise<
  FixActionResult<{
    history: DecodedHistory | null
    externalHistories: DecodedHistory[]
    branch: string | null
    base: string | null
    currentSpec: { body: string; digest: string } | null
  }>
> {
  if (target.kind !== 'pull-request') {
    return { ok: true, value: { history: null, externalHistories: [], branch: null, base: null, currentSpec: null } }
  }
  const raw = await readWorkflowBinding({ repository: target.repository, target: target.target }, options)
  if (!raw.ok) {
    if (raw.status !== 'absent') {
      const foreign = raw.diagnostics.some((item) => item.code === 'foreign')
      return failure(`fix-binding-${foreign ? 'foreign' : raw.reason}`, ...raw.diagnostics.map((item) => item.code))
    }
    const native = await nativePullRequest(target, options)
    if (!native.ok) return native
    return {
      ok: true,
      value: {
        history: null,
        externalHistories: [],
        branch: native.value.branch,
        base: native.value.base,
        currentSpec: null,
      },
    }
  }
  const confirmed = confirmedWorkflowBinding(raw.value)
  if (confirmed === null) return failure('fix-binding-unreadable')
  if (!confirmed.history.source.complete) return failure('fix-parent-history-incomplete')
  const native = liveNativeBranch(raw.value)
  if (native === null) return failure('fix-binding-unreadable')
  const pullRequest = { repository: target.repository, target: target.target }
  return {
    ok: true,
    value: {
      history: confirmed.history,
      externalHistories: confirmed.histories.filter(
        (item) => !sameScope(item.source.scope, confirmed.mandateScope) && !sameScope(item.source.scope, pullRequest),
      ),
      branch: native.branch,
      base: native.base,
      currentSpec: liveBoundSpec(raw.value.linkedIssueBodies),
    },
  }
}

export async function nativePullRequest(
  target: FixTarget,
  options: GitHubOptions,
): Promise<FixActionResult<{ branch: string; base: string }>> {
  try {
    const facts = await readNativePullRequestFacts(target.repository, target.number, options)
    return { ok: true, value: { branch: facts.branch, base: facts.base } }
  } catch (error) {
    return failure(`fix-binding-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
}

export function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

export function confirmedWorkflowBinding(value: unknown): {
  mandateScope: Scope
  history: DecodedHistory
  histories: DecodedHistory[]
  branch: string
  base: string
} | null {
  const envelope = objectValue(value)
  if (envelope === null) return null
  const binding = objectValue(envelope.binding)
  const payload = objectValue(binding?.payload)
  const mandate = externalRef(payload?.mandate)
  const history = decodedHistory(envelope.history)
  if (
    mandate === null ||
    history === null ||
    typeof payload?.branch !== 'string' ||
    typeof payload.base !== 'string' ||
    history.source.scope.repository !== mandate.scope.repository ||
    history.source.scope.target !== mandate.scope.target
  ) {
    return null
  }
  const histories = (Array.isArray(envelope.histories) ? envelope.histories : [history])
    .map((item) => decodedHistory(item))
    .filter((item): item is DecodedHistory => item !== null)
  return { mandateScope: mandate.scope, history, histories, branch: payload.branch, base: payload.base }
}

export function decodedHistory(value: unknown): DecodedHistory | null {
  const record = objectValue(value)
  const source = objectValue(record?.source)
  const scope = objectValue(source?.scope)
  if (
    record === null ||
    !Array.isArray(record.operations) ||
    typeof scope?.repository !== 'string' ||
    typeof scope.target !== 'string'
  ) {
    return null
  }
  return record as DecodedHistory
}
