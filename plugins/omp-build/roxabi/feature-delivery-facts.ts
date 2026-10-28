// Source: plugins/omp-build/roxabi/workflow.ts:1029-1139,1199-1315

import type { Gh } from '../adapters/github/types.ts'
import {
  decodedHistorySchema,
  effectiveMandateRole,
  type GitHubOptions,
  readNativePullRequestFacts,
  readWorkflowBinding,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import { explicitParentHistories } from './feature-context.ts'
import { discoverDeliveryPr } from './feature-delivery-discovery.ts'
import type { Contracts, History, Scope, WorkflowEvidence } from './feature-engine.ts'
import { isRecord, payload } from './feature-engine.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'

export type Delivery = {
  number: number
  scope: Scope
  head: string
  branch: string
  base: string
  history: History
  issueScope: Scope
}

export function scopeNumber(scope: Scope): number {
  const match = /#([1-9][0-9]*)$/.exec(scope.target)
  return match === null ? 0 : Number(match[1])
}

export function asHistory(value: unknown): DecodedHistory | null {
  const parsed = decodedHistorySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function historyForScope(histories: readonly unknown[], scope: Scope): DecodedHistory | null {
  for (const history of histories) {
    const parsed = asHistory(history)
    if (parsed?.source.scope.repository === scope.repository && parsed.source.scope.target === scope.target)
      return parsed
  }
  return null
}

export function boundEnds(binding: { kind: string; payload: unknown }): { branch: string; base: string } | null {
  if (binding.kind !== 'workflow-binding' || !isRecord(binding.payload)) return null
  const branch = binding.payload.branch
  const base = binding.payload.base
  if (typeof branch !== 'string' || branch.length === 0 || typeof base !== 'string' || base.length === 0) return null
  return { branch, base }
}

type Chantier = { ok: true; evidence: WorkflowEvidence; delivery: Delivery | null } | { ok: false; reason: string }
type BoundFacts = {
  issue: History | null
  pullRequest: History
  parents: History[]
  head: string
  branch: string
  base: string
}
type BoundRead = { status: 'ok'; value: BoundFacts } | { status: 'absent' } | { status: 'error'; reason: string }
type GitHubPolicy = GitHubOptions

function composeChantier(
  loaded: Contracts,
  issue: History,
  pullRequest: History | null,
  parents: History[],
  delivery: Delivery | null,
): Chantier {
  const composed = loaded.composeChantier({ issue, pullRequest, parents })
  return composed.ok
    ? { ok: true, evidence: composed.value, delivery }
    : { ok: false, reason: composed.diagnostics[0]?.code ?? 'incomplete' }
}

function boundParents(histories: readonly unknown[], scopes: readonly Scope[]): History[] | null {
  const parents: History[] = []
  for (const scope of scopes) {
    const parent = historyForScope(histories, scope)
    if (parent === null) return null
    parents.push(parent)
  }
  return parents
}

async function readBoundFacts(scope: Scope, policy: GitHubPolicy, requireIssue: boolean): Promise<BoundRead> {
  const binding = await readWorkflowBinding(scope, policy)
  if (!binding.ok)
    return binding.status === 'absent' ? { status: 'absent' } : { status: 'error', reason: binding.status }
  const issue = asHistory(binding.value.history)
  const pullRequest = historyForScope(binding.value.histories, scope)
  const parents = boundParents(binding.value.histories, binding.value.parentScopes)
  const ends = boundEnds(binding.value.binding)
  const head = binding.value.observed.head
  if ((requireIssue && issue === null) || pullRequest === null || parents === null) {
    return { status: 'error', reason: 'binding-incomplete' }
  }
  if (!/^[0-9a-f]{40}$/.test(head) || ends === null) return { status: 'error', reason: 'native-metadata-unreadable' }
  return { status: 'ok', value: { issue, pullRequest, parents, head, branch: ends.branch, base: ends.base } }
}

function deliveryFromBound(
  number: number,
  scope: Scope,
  issueScope: Scope,
  facts: Omit<BoundFacts, 'issue'>,
): Delivery {
  return {
    number,
    scope,
    head: facts.head,
    branch: facts.branch,
    base: facts.base,
    history: facts.pullRequest,
    issueScope,
  }
}

function appendMissingParents(parents: History[], additions: History[]): void {
  for (const parent of additions) {
    if (
      !parents.some(
        (known) =>
          known.source.scope.repository === parent.source.scope.repository &&
          known.source.scope.target === parent.source.scope.target,
      )
    ) {
      parents.push(parent)
    }
  }
}

async function discoverIssueDelivery(
  loaded: Contracts,
  targetScope: Scope,
  primary: History,
  mandate: History['operations'][number]['record'] | null,
  options: { cwd: string; gh: Gh },
  parents: History[],
  policy: GitHubPolicy,
): Promise<{ ok: true; pullRequest: History | null; delivery: Delivery | null } | { ok: false; reason: string }> {
  const mandatePayload = mandate?.kind === 'mandate' ? payload(mandate) : null
  const branch = mandatePayload?.branch
  const base = mandatePayload?.base
  if (typeof branch !== 'string' || branch.length === 0 || typeof base !== 'string' || base.length === 0) {
    return { ok: true, pullRequest: null, delivery: null }
  }
  const discovered = await discoverDeliveryPr(options.gh, options.cwd, branch, base)
  if (!discovered.ok) return discovered
  if (discovered.number === null) return { ok: true, pullRequest: null, delivery: null }
  const scope = loaded.githubScope(targetScope.repository, discovered.number)
  const facts = await readBoundFacts(scope, policy, false)
  if (facts.status === 'ok') {
    appendMissingParents(parents, facts.value.parents)
    return {
      ok: true,
      pullRequest: facts.value.pullRequest,
      delivery: deliveryFromBound(discovered.number, scope, primary.source.scope, facts.value),
    }
  }
  if (facts.status === 'error') return { ok: false, reason: facts.reason }
  const history = await loaded.readComposedWorkflowHistory([scope], options)
  if (!history.ok || !history.histories[0]) return { ok: false, reason: history.ok ? 'incomplete' : history.reason }
  try {
    const native = await readNativePullRequestFacts(scope.repository, discovered.number, policy)
    return {
      ok: true,
      pullRequest: history.histories[0],
      delivery: {
        number: discovered.number,
        scope,
        head: native.head,
        branch: native.branch,
        base: native.base,
        history: history.histories[0],
        issueScope: primary.source.scope,
      },
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'native-metadata-unreadable' }
  }
}

function mandateRole(
  mandate: History['operations'][number]['record'] | null,
  acceptedSpec: AcceptedOwnSpec | null,
): 'feature' | 'epic' | 'fix-only' | null {
  if (mandate?.kind !== 'mandate' || acceptedSpec === null) return null
  return effectiveMandateRole(mandate.payload.role, acceptedSpec)
}

async function epicChantier(
  loaded: Contracts,
  primary: History,
  mandate: History['operations'][number]['record'] | null,
  options: { cwd: string; gh: Gh },
): Promise<Chantier> {
  const granted = await explicitParentHistories(loaded, mandate, options)
  return granted.ok ? composeChantier(loaded, primary, null, granted.parents, null) : granted
}

async function pullRequestChantier(loaded: Contracts, targetScope: Scope, policy: GitHubPolicy): Promise<Chantier> {
  const facts = await readBoundFacts(targetScope, policy, true)
  if (facts.status === 'absent') return { ok: false, reason: 'binding-missing' }
  if (facts.status === 'error' || facts.value.issue === null)
    return { ok: false, reason: facts.status === 'error' ? facts.reason : 'binding-incomplete' }
  const delivery = deliveryFromBound(scopeNumber(targetScope), targetScope, facts.value.issue.source.scope, facts.value)
  return delivery.number === 0
    ? { ok: false, reason: 'binding-incomplete' }
    : composeChantier(loaded, facts.value.issue, facts.value.pullRequest, facts.value.parents, delivery)
}

async function issueChantier(
  loaded: Contracts,
  targetScope: Scope,
  primary: History,
  mandate: History['operations'][number]['record'] | null,
  options: { cwd: string; gh: Gh },
  policy: GitHubPolicy,
): Promise<Chantier> {
  const granted = await explicitParentHistories(loaded, mandate, options)
  if (!granted.ok) return granted
  const delivery = await discoverIssueDelivery(loaded, targetScope, primary, mandate, options, granted.parents, policy)
  return delivery.ok
    ? composeChantier(loaded, primary, delivery.pullRequest, granted.parents, delivery.delivery)
    : delivery
}

export async function assembleChantier(
  loaded: Contracts,
  target: { status: 'issue' | 'pull-request'; scope: Scope },
  primary: History,
  mandate: History['operations'][number]['record'] | null,
  acceptedSpec: AcceptedOwnSpec | null,
  options: { cwd: string; gh: Gh },
): Promise<Chantier> {
  const role = mandateRole(mandate, acceptedSpec)
  if (mandate?.kind === 'mandate' && role === null) return { ok: false, reason: 'mandate-spec-missing' }
  if (role === 'epic') return epicChantier(loaded, primary, mandate, options)
  const policy = withRoxabiGitHubPolicy({ cwd: options.cwd, gh: options.gh })
  return target.status === 'pull-request'
    ? pullRequestChantier(loaded, target.scope, policy)
    : issueChantier(loaded, target.scope, primary, mandate, options, policy)
}
