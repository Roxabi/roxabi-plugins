// Source: plugins/omp-build/roxabi/workflow.ts:638-705,2009-2156

import { randomUUID } from 'node:crypto'
import { resolveAcceptedSpec, sameScope, terminalMandate } from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import type { NativeDeliveryPullRequest } from '../engine/uw-completion-types.ts'
import type { UwTier } from '../engine/uw-spec.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { AcceptedChildCommitment, MandatePayload } from '../engine/workflow-mandate-schema.ts'
import type { TerminalMandate } from '../engine/workflow-terminal-mandate.ts'
import { type Contracts, type History, type HistoryRecord, publishRecord, type Scope } from './feature-engine.ts'
import {
  prepareSuccessorBinding,
  preserveSuccessorBinding,
  recheckSuccessorBinding,
} from './feature-succession-binding.ts'
import { publishAndRefreshSuccessor } from './feature-succession-refresh.ts'

export type { Gh } from './feature-succession-binding.ts'

import type { Gh } from './feature-succession-binding.ts'
import type { FeatureCheckoutTarget, GitRunner } from './workflow-checkout.ts'
import { configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'
import { parseWorkflowOverride } from './workflow-overrides.ts'

type MandateRecord = Extract<HistoryRecord, { kind: 'mandate' }>
type SuccessorShared = Pick<
  MandateRecord['payload'],
  | 'format'
  | 'branch'
  | 'base'
  | 'lineageHead'
  | 'config'
  | 'parent'
  | 'antecedent'
  | 'ownSpec'
  | 'tier'
  | 'children'
  | 'inheritedOwnSpecRefs'
  | 'coverage'
>

export type SuccessionBasis = Readonly<{ terminal: TerminalMandate; historical: AcceptedOwnSpec }>

export function readSuccessionBasis(history: History, histories: readonly History[]): Result<SuccessionBasis> {
  const terminal = terminalMandate(history)
  if (!terminal.ok) return terminal
  const historical = resolveAcceptedSpec(terminal.value.mandate, histories)
  return historical.ok
    ? { ok: true, value: { terminal: terminal.value, historical: historical.spec } }
    : { ok: false, diagnostics: historical.evidence }
}

type SuccessorAntecedent = { scope: Scope; recordId: string; kind: 'mandate' }

function confirmSuccessorAntecedent(
  history: History,
  scope: Scope,
  expected: TerminalMandate['ref'],
): { ok: true; value: TerminalMandate } | { ok: false; reason: string } {
  const antecedent = terminalMandate(history)
  if (!antecedent.ok) return { ok: false, reason: 'successor-antecedent-unconfirmed' }
  if (
    !sameScope(scope, antecedent.value.ref.scope) ||
    !sameScope(antecedent.value.ref.scope, expected.scope) ||
    antecedent.value.ref.recordId !== expected.recordId
  )
    return { ok: false, reason: 'successor-antecedent-changed' }
  return antecedent
}

function invalidSuccessorRun(payload: ReturnType<typeof successorRolePayload>): boolean {
  return payload.role === 'epic' && !/^[a-z0-9]{8}$/.test(payload.run)
}

export async function publishSuccessorMandate(input: {
  loaded: Contracts
  history: History
  scope: Scope
  basis: SuccessionBasis
  ownSpec: MandatePayload['ownSpec']
  tier: UwTier
  children: AcceptedChildCommitment[]
  inheritedOwnSpecRefs: MandatePayload['inheritedOwnSpecRefs']
  coverage: MandatePayload['coverage']
  git: GitRunner
  gh: Gh
  cwd: string
  parents: readonly History[]
  target: FeatureCheckoutTarget
  observedPullRequests: readonly NativeDeliveryPullRequest[]
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const antecedent = confirmSuccessorAntecedent(input.history, input.scope, input.basis.terminal.ref)
  if (!antecedent.ok) return antecedent
  const productVersion = input.loaded.shippedProductVersion()
  const prior = antecedent.value.mandate.payload
  const baseAndBranch = { base: prior.base, branch: input.target.kind === 'parent' ? null : input.target.branch }
  const shared = await successorShared(input, antecedent.value.ref, prior, baseAndBranch, productVersion)
  if (!shared.ok) return shared
  const rolePayload = successorRolePayload(prior, shared.shared)
  if (invalidSuccessorRun(rolePayload)) {
    return { ok: false, reason: 'epic-run-unreadable' }
  }
  const bindingContext = {
    loaded: input.loaded,
    gh: input.gh,
    cwd: input.cwd,
    successorScope: input.scope,
    branch: baseAndBranch.branch,
    base: baseAndBranch.base,
  }
  const preparedBinding = await prepareSuccessorBinding(
    bindingContext,
    input.history,
    antecedent.value.ref,
    input.observedPullRequests,
  )
  if (!preparedBinding.ok) return preparedBinding
  const successorId = randomUUID()
  const controlId = randomUUID()
  const refreshed = await publishAndRefreshSuccessor(input, successorId, rolePayload)
  if (!refreshed.ok) return refreshed
  const beforeControl = await recheckSuccessorBinding(bindingContext, preparedBinding.plan)
  if (!beforeControl.ok) return beforeControl
  const controlPublished = await publishRecord(
    input.loaded,
    refreshed.history,
    successorControlRecord(input.scope, antecedent.value.ref, successorId, controlId),
    input.gh,
    input.cwd,
    input.parents,
  )
  if (!controlPublished.ok) return { ok: false, reason: controlPublished.reason }
  let bindingHistory = refreshed.history
  if (preparedBinding.plan.kind === 'pull-request') {
    const afterControl = await input.loaded.readComposedWorkflowHistory([input.scope], refreshed.readOptions)
    if (!afterControl.ok || !afterControl.histories[0]) return { ok: false, reason: 'successor-unconfirmed' }
    bindingHistory = afterControl.histories[0]
  }
  const bound = await preserveSuccessorBinding(bindingContext, preparedBinding.plan, successorId, bindingHistory)
  if (!bound.ok) return bound
  return { ok: true }
}

async function successorShared(
  input: {
    loaded: Contracts
    scope: Scope
    ownSpec: MandatePayload['ownSpec']
    tier: UwTier
    children: AcceptedChildCommitment[]
    inheritedOwnSpecRefs: MandatePayload['inheritedOwnSpecRefs']
    coverage: MandatePayload['coverage']
    git: GitRunner
    cwd: string
  },
  antecedent: SuccessorAntecedent,
  prior: MandateRecord['payload'],
  baseAndBranch: { base: string; branch: string | null },
  productVersion: string,
): Promise<{ ok: true; shared: SuccessorShared } | { ok: false; reason: string }> {
  const head = await input.git(input.cwd, ['rev-parse', 'HEAD'])
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim()))
    return { ok: false, reason: 'successor-head-unreadable' }
  const override = await input.git(input.cwd, ['show', `refs/remotes/origin/${baseAndBranch.base}:.dev/stack.yml`])
  const parsed = parseWorkflowOverride(override.code === 0 ? override.stdout : null)
  if (!parsed.ok) return { ok: false as const, reason: parsed.reason }
  const effective = effectiveWorkflowConfig(productVersion, parsed.additionalRequirements)
  return {
    ok: true as const,
    shared: {
      format: 'omp-build-mandate/4',
      branch: baseAndBranch.branch,
      base: baseAndBranch.base,
      lineageHead: head.stdout.trim(),
      config: { productVersion, version: WORKFLOW_CONFIG_VERSION, digest: configPinDigest(effective), effective },
      parent: prior.parent,
      antecedent,
      ownSpec: input.ownSpec,
      tier: input.tier,
      children: input.children,
      inheritedOwnSpecRefs: input.inheritedOwnSpecRefs,
      coverage: input.coverage,
    },
  }
}

function successorRolePayload(prior: MandateRecord['payload'], shared: SuccessorShared): MandateRecord['payload'] {
  if (prior.role === 'epic') {
    return {
      role: 'epic',
      ...shared,
      run: prior.run,
      permissions: prior.permissions,
    }
  }
  if (prior.role === 'fix-only') {
    return {
      role: 'fix-only',
      ...shared,
      run: null,
      permissions: { landing: false, correct: true },
    }
  }
  return {
    role: 'feature',
    ...shared,
    run: prior.run,
    permissions: prior.permissions,
  }
}

function successorControlRecord(
  scope: Scope,
  antecedent: SuccessorAntecedent,
  successorId: string,
  controlId: string,
): Omit<Extract<HistoryRecord, { kind: 'operator-control' }>, 'inputs'> {
  return {
    repository: scope.repository,
    target: scope.target,
    version: 1,
    recordId: randomUUID(),
    runId: randomUUID(),
    operationId: randomUUID(),
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId,
      predecessor: antecedent,
      successor: { scope, recordId: successorId, kind: 'mandate' },
      mandate: antecedent,
    },
  }
}
