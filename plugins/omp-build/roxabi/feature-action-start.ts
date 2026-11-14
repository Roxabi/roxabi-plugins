import { randomUUID } from 'node:crypto'
import { canonicalValueDigest } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import {
  actionRequest,
  blocks,
  confirmPreparedAction,
  observeHeadCode,
  observeSha,
  prepareDeliveryAction,
  prepareRefusal,
  uwSubject,
} from './delivery-action.ts'
import {
  type Gh,
  type ModelReceiptActionInput,
  receiptStartContext,
  sealReceipt,
  startAssessmentReceipt,
  startCiAttributionReceipt,
} from './feature-action-receipt.ts'
import { approvedMandateContext, finalEligiblePlanActionId } from './feature-approved-context.ts'
import { explicitParentHistories } from './feature-context.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { cwdInhibition, inhibition } from './feature-control.ts'
import type { Contracts, History, WorkflowEvidence } from './feature-engine.ts'
import { proveAuthorizedPublishedBase } from './feature-publication.ts'
import { readFreshUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { PreparedUwAction, RecordInputRef } from './uw-action-contract.ts'
import { integrationProofInputs } from './uw-action-stage-closure.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

export async function startModelReceiptAction(input: ModelReceiptActionInput): Promise<ContinueFeatureResult> {
  const context = receiptStartContext(input)
  return input.action === 'assess-spec'
    ? startAssessmentReceipt(input, context)
    : startCiAttributionReceipt(input, context)
}

async function integrationSources(
  uw: UwOperations,
  scope: Scope,
  accepted: AcceptedOwnSpec,
): Promise<{ sources: readonly RecordInputRef[] } | ContinueFeatureResult> {
  const read = await uw.readUw(scope)
  if (
    read.observation.status !== 'complete' ||
    read.accepted.status !== 'accepted' ||
    canonicalValueDigest(read.accepted.value) !== canonicalValueDigest(accepted)
  )
    return blocks('integration-observation-incomplete')
  const projected = integrationProofInputs(read)
  if (!projected.ok) return blocks(prepareRefusal(projected.diagnostics), projected.diagnostics)
  return { sources: projected.value.stageSources }
}

async function integrationStartSources(
  git: GitRunner,
  cwd: string,
  base: string,
  uw: UwOperations,
  scope: Scope,
  accepted: AcceptedOwnSpec,
): Promise<{ base: string; sources: readonly RecordInputRef[] } | ContinueFeatureResult> {
  const tip = await observeSha(git, cwd, `origin/${base}`)
  if (tip === null) return blocks('integration-base-unobserved')
  const projected = await integrationSources(uw, scope, accepted)
  if ('kind' in projected) return projected
  return { base: tip, sources: projected.sources }
}

function integrationStartOperands(action: 'integrate' | 'implement', mandateId: string, planActionId: string) {
  return action === 'integrate'
    ? { operands: { action: 'integrate' as const, exactInputs: { mandateId, planActionId } } }
    : {}
}

type IntegrationStartPreflight = {
  loaded: Contracts
  scope: Scope
  cwd: string
  gh: Gh
  git: GitRunner
  mandate: MandateRecord
  uw: UwOperations
  prepared: PreparedUwAction
  head: string
}

async function integrationStartAuthority(
  input: IntegrationStartPreflight,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { loaded, scope, cwd, gh, mandate, uw, prepared } = input
  if (cwdInhibition(cwd) !== undefined || inhibition(scope) !== undefined)
    return { ok: false, reason: 'integration-local-inhibition' }
  const options = { ...withRoxabiGitHubPolicy({ cwd, gh }), gh }
  const fresh = await loaded.readComposedWorkflowHistory([scope], options)
  if (!fresh.ok || !fresh.histories[0]) return { ok: false, reason: 'integration-authority-unreadable' }
  const currentHistory = fresh.histories[0]
  const currentMandate = currentHistory.operations.find(
    (operation) => operation.record?.kind === 'mandate' && operation.record.recordId === mandate.recordId,
  )?.record
  if (currentMandate?.kind !== 'mandate') return { ok: false, reason: 'integration-authority-unreadable' }
  const parents = await explicitParentHistories(loaded, currentMandate, options)
  if (!parents.ok) return { ok: false, reason: 'integration-authority-unreadable' }
  const causal = await readFreshUwCausalContext(scope, [currentHistory, ...parents.parents], options)
  if (!causal.ok) return { ok: false, reason: 'integration-authority-unreadable' }
  const selected = loaded.selectApplicableMandate(currentHistory, parents.parents, causal.value)
  const verified = await uw.verifyAction(prepared.snapshot)
  if (cwdInhibition(cwd) !== undefined || inhibition(scope) !== undefined)
    return { ok: false, reason: 'integration-local-inhibition' }
  if (
    selected.status !== 'applicable' ||
    selected.mandate?.recordId !== mandate.recordId ||
    canonicalValueDigest(selected.mandate) !== canonicalValueDigest(mandate) ||
    !verified.ok
  )
    return { ok: false, reason: 'integration-authority-withdrawn' }
  return { ok: true }
}

async function preflightIntegrationStart(input: IntegrationStartPreflight) {
  return proveAuthorizedPublishedBase(
    input.git,
    input.cwd,
    input.gh,
    input.scope.repository,
    input.mandate.payload.base,
    input.head,
    () => integrationStartAuthority(input),
  )
}

export async function startImplement(
  loaded: Contracts,
  evidence: WorkflowEvidence,
  history: History,
  scope: Scope,
  issue: { body: string },
  git: GitRunner,
  gh: Gh,
  cwd: string,
  mandate: NonNullable<History['operations'][number]['record']>,
  uw: UwOperations | undefined,
): Promise<ContinueFeatureResult> {
  void issue
  const composed = evidence.parents
  const approved = approvedMandateContext(loaded, mandate, evidence.causal?.histories ?? [history, ...composed])
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  if (approved.status !== 'ready') return { kind: 'blocked', reason: 'mandate-spec-missing' }
  const macro = loaded.planMacro(evidence, approved.mandate)
  const planAction = finalEligiblePlanActionId(macro)
  if (planAction === null) return { kind: 'blocked', reason: 'plan-unconfirmed' }
  const action = approved.accepted.children.length > 0 ? 'integrate' : 'implement'
  const operationId = randomUUID()
  const code = await observeHeadCode(git, cwd, scope.repository)
  if (!code.ok) return blocks(code.reason)
  if (uw === undefined) return blocks('prepare-action-unavailable')
  const stageSources: RecordInputRef[] = []
  if (action === 'integrate') {
    const projected = await integrationStartSources(
      git,
      cwd,
      approved.mandate.payload.base,
      uw,
      scope,
      approved.accepted,
    )
    if ('kind' in projected) return projected
    code.code.base = projected.base
    stageSources.push(...projected.sources)
  }
  const prepared = await (action === 'integrate' ? confirmPreparedAction : prepareDeliveryAction)(
    uw,
    actionRequest({
      actionId: operationId,
      purpose: action,
      subject: uwSubject(scope, null),
      code: code.code,
      ...integrationStartOperands(action, approved.mandate.recordId, planAction),
      stageSources,
    }),
  )
  if (!prepared.ok) return blocks(prepareRefusal(prepared.diagnostics), prepared.diagnostics)
  if (action === 'integrate') {
    const published = await preflightIntegrationStart({
      loaded,
      scope,
      cwd,
      gh,
      git,
      mandate: approved.mandate,
      uw,
      prepared: prepared.value,
      head: code.code.head,
    })
    if (!published.ok) return blocks(published.reason)
  }
  return sealReceipt({
    loaded,
    history,
    scope,
    cwd,
    gh,
    parents: composed,
    operationId,
    action,
    mandate: { scope, recordId: approved.mandate.recordId, kind: 'mandate' },
    exactInputs: { mandateId: approved.mandate.recordId, planActionId: planAction },
    prepared: prepared.value,
  })
}
