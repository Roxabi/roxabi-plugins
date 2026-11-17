// Source: plugins/omp-build/roxabi/workflow.ts:638-705,2009-2156

import { randomUUID } from 'node:crypto'
import {
  admitContextSuccession,
  resolveAcceptedSpec,
  resolveAcceptedSpecForAbandonment,
  sameScope,
  terminalMandate,
  validateContextSuccessionProposal,
} from '../dist/contracts.js'
import { canonicalValueDigest } from '../engine/canonical-value.ts'
import type { Result } from '../engine/result.ts'
import type { NativeDeliveryPullRequest } from '../engine/uw-completion-types.ts'
import type { UwTier } from '../engine/uw-spec.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { ContextSuccessionProposal } from '../engine/workflow-context-disposition-schema.ts'
import type { AcceptedChildCommitment, MandatePayload } from '../engine/workflow-mandate-schema.ts'
import type { TerminalMandate } from '../engine/workflow-terminal-mandate.ts'
import type { ContextHandoffObservation } from './feature-context-handoff-observation.ts'
import { type Contracts, type History, publishRecord, type Scope } from './feature-engine.ts'
import {
  prepareSuccessorBinding,
  preserveSuccessorBinding,
  recheckSuccessorBinding,
} from './feature-succession-binding.ts'
import { publishAndRefreshSuccessor } from './feature-succession-refresh.ts'
import { executeHostContextSuccession } from './uw-context-succession-operation.ts'
import type { UwOperations } from './uw-contract.ts'

export type { Gh } from './feature-succession-binding.ts'

import type { Gh } from './feature-succession-binding.ts'
import {
  handoffStages,
  readPublishedSuccessorHistory,
  sameHandoffObservation,
  successorControlRecord,
  successorRolePayload,
  successorShared,
} from './feature-succession-records.ts'
import type { FeatureCheckoutTarget, GitRunner } from './workflow-checkout.ts'

export type SuccessionBasis = Readonly<{ terminal: TerminalMandate; historical: AcceptedOwnSpec }>

export type ContextHandoffPublication = {
  operations: UwOperations
  observed: ContextHandoffObservation
  observe(prospective?: {
    ref: SuccessorAntecedent
    payloadDigest: string
    before: History
  }): Promise<{ ok: true; value: ContextHandoffObservation } | { ok: false; reason: string }>
}

export function readSuccessionBasis(
  history: History,
  histories: readonly History[],
  contextHandoff = false,
): Result<SuccessionBasis> {
  const terminal = terminalMandate(history)
  if (!terminal.ok) return terminal
  const historical = contextHandoff
    ? resolveAcceptedSpecForAbandonment(terminal.value.mandate, histories)
    : resolveAcceptedSpec(terminal.value.mandate, histories)
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
  contextHandoff?: ContextHandoffPublication
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
  if (input.contextHandoff !== undefined) {
    return publishContextSuccessor(
      input,
      antecedent.value.ref,
      prior,
      rolePayload,
      baseAndBranch,
      successorId,
      controlId,
    )
  }
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

async function publishContextSuccessor(
  input: Parameters<typeof publishSuccessorMandate>[0],
  antecedent: SuccessorAntecedent,
  prior: MandatePayload,
  payload: MandatePayload,
  baseAndBranch: { base: string; branch: string | null },
  successorId: string,
  controlId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const handoff = input.contextHandoff
  if (handoff === undefined) return { ok: false, reason: 'context-handoff-reconciliation-unavailable' }
  const successor = { scope: input.scope, recordId: successorId, kind: 'mandate' as const }
  const operationId = randomUUID()
  const proposal: ContextSuccessionProposal = {
    format: 'omp-build-context-succession/1',
    uw: input.scope,
    operationId,
    controlId,
    predecessor: antecedent,
    successor,
    successorPayloadDigest: canonicalValueDigest(payload),
    predecessorConfig: prior.config,
    successorConfig: payload.config,
    negative: handoff.observed.negative,
    replacementAccepted: handoff.observed.replacementAccepted,
    reconciliation: handoff.observed.reconciliation,
  }
  try {
    if (!validateContextSuccessionProposal(proposal, payload, handoff.observed.histories).ok)
      return { ok: false, reason: 'context-handoff-admission-refused' }
  } catch {
    return { ok: false, reason: 'context-handoff-admission-unavailable' }
  }
  let publishedHistory: History | undefined
  let failureStage = 'confirmation'
  const fresh = async (afterPublication: boolean) => {
    const stages = afterPublication ? handoffStages.preselection : handoffStages.premandate
    failureStage = stages.observation
    const observed = await handoff.observe(
      afterPublication
        ? { ref: successor, payloadDigest: proposal.successorPayloadDigest, before: input.history }
        : undefined,
    )
    if (!observed.ok) return false
    failureStage = stages.reconciliation
    if (!sameHandoffObservation(observed.value, proposal)) return false
    failureStage = stages.admission
    const admission = validateContextSuccessionProposal(proposal, payload, observed.value.histories)
    if (!admission.ok) {
      failureStage +=
        '-' + (admission.diagnostics[0]?.message ?? 'unconfirmed').replace(/[^a-z0-9,-]/gi, '-').slice(0, 80)
      return false
    }
    failureStage = stages.config
    const shared = await successorShared(input, antecedent, prior, baseAndBranch, input.loaded.shippedProductVersion())
    return (
      shared.ok && canonicalValueDigest(successorRolePayload(prior, shared.shared)) === proposal.successorPayloadDigest
    )
  }
  const result = await executeHostContextSuccession(handoff.operations, proposal, {
    validateBeforeMandate: () => fresh(false),
    validateBeforeSelection: () => fresh(true),
    publishMandate: async () => {
      failureStage = 'mandate-publication'
      const published = await publishAndRefreshSuccessor(input, successorId, payload)
      if (!published.ok) {
        failureStage = 'mandate-publication-' + published.reason.replace(/[^a-z0-9,-]/gi, '-').slice(0, 80)
        return false
      }
      publishedHistory = published.history
      return true
    },
    publishSelection: async (_proposal, evidence) => {
      failureStage = 'selection-preparation'
      if (publishedHistory === undefined) return false
      const control = successorControlRecord(input.scope, antecedent, successorId, controlId)
      if (control.payload.control !== 'select-successor') return false
      const record = {
        ...control,
        operationId,
        payload: {
          ...control.payload,
          contextDisposition: {
            kind: 'superseded-not-delivered' as const,
            negative: proposal.negative,
            replacementAccepted: proposal.replacementAccepted,
            reconciliation: proposal.reconciliation,
            proposalDigest: canonicalValueDigest(proposal),
            confirmation: evidence,
          },
        },
      }
      failureStage = 'selection-publication'
      const published = await publishRecord(input.loaded, publishedHistory, record, input.gh, input.cwd, input.parents)
      if (!published.ok) {
        failureStage = 'selection-publication-' + published.reason.replace(/[^a-z0-9,-]/gi, '-').slice(0, 80)
        return false
      }
      failureStage = 'selection-readback'
      const home = await readPublishedSuccessorHistory(input)
      if (home === null) return false
      const observedControl = home.operations.find((entry) => entry.recordId === record.recordId)?.record
      if (observedControl?.kind !== 'operator-control') return false
      failureStage = 'selection-admission'
      const histories = handoff.observed.histories.map((history) =>
        sameScope(history.source.scope, input.scope) ? home : history,
      )
      const admission = admitContextSuccession(observedControl, histories)
      if (!admission.ok)
        failureStage +=
          '-' + (admission.diagnostics[0]?.message ?? 'unconfirmed').replace(/[^a-z0-9,-]/gi, '-').slice(0, 80)
      return admission.ok
    },
  })
  return result.status === 'published'
    ? { ok: true }
    : { ok: false, reason: `context-handoff-${result.status}:${failureStage}` }
}
