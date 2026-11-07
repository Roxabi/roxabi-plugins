import type { AcceptedOwnSpec, AssessSpecExact, DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import {
  assessUwAdmission,
  projectNativeUwChildren,
  readLinkedIssueAssociation,
  readNativePullRequestFacts,
  readWorkflowBinding,
} from '../dist/contracts.js'
import type { FixActionResult, FixTarget } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { externalRef, objectValue } from './fix-mandate-types.ts'
import { composeObservedUwCausalContext, type FixUwCausalContext } from './fix-uw-histories.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { readCurrentOwnSpecFacts } from './uw-current-facts.ts'
import { createInstalledObservedUwReadPort } from './uw-read-port.ts'

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
  uw: UwReadPort,
): Promise<
  FixActionResult<{
    history: DecodedHistory | null
    externalHistories: DecodedHistory[]
    branch: string | null
    base: string | null
    currentSpec:
      | (AssessSpecExact['proposed'] & {
          ownSpec: AcceptedOwnSpec
          read: UwRead
          causal: FixUwCausalContext
        })
      | null
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
    return unboundPullRequest(target, options, uw)
  }
  const confirmed = confirmedWorkflowBinding(raw.value)
  if (confirmed === null) return failure('fix-binding-unreadable')
  if (!confirmed.history.source.complete) return failure('fix-parent-history-incomplete')
  const native = liveNativeBranch(raw.value)
  if (native === null) return failure('fix-binding-unreadable')
  const currentSpec = await freshBoundOwnSpec(
    uw,
    confirmed.mandateScope,
    [confirmed.history, ...confirmed.histories.filter((item) => !sameScope(item.source.scope, confirmed.mandateScope))],
    options,
  )
  if (!currentSpec.ok) return currentSpec
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
      currentSpec: currentSpec.value,
    },
  }
}

async function unboundPullRequest(target: FixTarget, options: GitHubOptions, uw: UwReadPort) {
  const association = await readLinkedIssueAssociation(target.repository, target.number, options)
  if (association.status === 'linked') {
    const checked = await checkUnboundLinkedIssue(uw, association.scope)
    if (!checked.ok) return checked
  } else if (association.status !== 'none') {
    return failure<never>('fix-binding-unreadable', ...association.diagnostics.map((item) => item.code))
  }
  const native = await nativePullRequest(target, options)
  if (!native.ok) return native
  return {
    ok: true as const,
    value: {
      history: null,
      externalHistories: [],
      branch: native.value.branch,
      base: native.value.base,
      currentSpec: null,
    },
  }
}

async function checkUnboundLinkedIssue(uw: UwReadPort, scope: Scope): Promise<FixActionResult<void>> {
  let linked: UwRead
  try {
    linked = await uw.readUw(scope)
  } catch {
    return failure('fix-binding-unreadable', 'fix-linked-uw-indeterminate')
  }
  const mandateClaim = linked.histories.some((history) =>
    history.operations.some(
      (operation) =>
        operation.authority !== 'foreign' &&
        (operation.kind === 'mandate' || operation.claimedKinds.includes('mandate')),
    ),
  )
  if (
    linked.accepted.status !== 'absent' ||
    !linked.identity.ok ||
    linked.graph.status !== 'complete' ||
    mandateClaim ||
    linked.histories.length === 0 ||
    linked.histories.some(
      (history) =>
        !history.source.complete ||
        history.source.diagnostics.length > 0 ||
        history.diagnostics.length > 0 ||
        history.operations.some((operation) => operation.authority !== 'foreign' && operation.status !== 'complete'),
    )
  )
    return failure('fix-binding-unreadable', 'fix-linked-uw-managed')
  return { ok: true, value: undefined }
}

async function freshBoundOwnSpec(
  port: UwReadPort,
  scope: Scope,
  histories: readonly DecodedHistory[],
  options: GitHubOptions,
): Promise<
  FixActionResult<
    AssessSpecExact['proposed'] & {
      ownSpec: AcceptedOwnSpec
      read: UwRead
      causal: FixUwCausalContext
    }
  >
> {
  let read: UwRead
  try {
    read = await port.readUw(scope)
  } catch {
    return failure('fix-own-uw-unreadable')
  }
  if (!read.identity.ok) return failure('fix-own-uw-unsettled', ...read.identity.diagnostics.map((item) => item.code))
  const causal = await composeObservedUwCausalContext(read, histories, options)
  if (!causal.ok) return causal
  read = await createInstalledObservedUwReadPort({ observation: causal.value.observation }).readUw(scope)
  if (!read.identity.ok) return failure('fix-own-uw-unsettled')
  const admission = assessUwAdmission({
    uw: scope,
    graph: read.graph,
    proposed: read.proposed,
    accepted: read.accepted,
    identities: read.identity.value,
    phase: 'delivery-transition',
    currentChildren: { ok: true, value: [] },
    histories: causal.value.histories,
    catalogues: causal.value.catalogues,
    completion: read.completion,
  })
  if (!admission.deliverable.ok)
    return failure('fix-own-uw-unsettled', ...admission.deliverable.diagnostics.map((item) => item.code))
  if (!read.proposed.ok || read.accepted.status !== 'accepted') return failure('fix-own-uw-unsettled')
  const root = read.graph.nodes.find((node) => sameScope(node.uw, scope))
  const children = projectNativeUwChildren({ uw: scope, graph: read.graph, accepted: read.accepted })
  if (root === undefined || !children.ok || children.value.length !== 0) return failure('fix-own-uw-unsettled')
  const current = await readCurrentOwnSpecFacts({ uw: scope, read })
  if (!current.ok) return failure('fix-own-uw-unsettled', ...current.diagnostics.map((item) => item.code))
  return {
    ok: true,
    value: {
      ...current.value.currentSpec,
      ownSpec: read.accepted.value,
      causal: causal.value,
      read,
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
