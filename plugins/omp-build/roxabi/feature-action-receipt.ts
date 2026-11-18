import { randomUUID } from 'node:crypto'
import {
  canonicalActionOperands,
  canonicalValueDigest,
  historyFor,
  outstandingPauseRequest,
  selectWorkflowBinding,
  unliftedPause,
} from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { AssessmentProposalOrigin, CiExact } from '../engine/workflow-action-operands.ts'
import type { ActionReceiptPayload, AssessSpecExact } from '../engine/workflow-receipt-schema.ts'
import { blocks, confirmStartReadback } from './delivery-action.ts'
import { preparedModelAction } from './feature-action-prompts.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, publishRecord, type WorkflowEvidence } from './feature-engine.ts'
import type { PreparedUwAction, UwActionRequest } from './uw-action-contract.ts'
import { sourceRef } from './uw-action-observe.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'
import type { UwOperations } from './uw-contract.ts'
import type { GitRunner } from './workflow-checkout.ts'

export type Gh = (cwd: string, args: string[]) => Promise<string>

export type ModelReceiptActionInput = {
  action: 'assess-spec' | 'attribute-ci'
  loaded: Contracts
  history: History
  mandateHistory?: History
  mandate: NonNullable<History['operations'][number]['record']>
  evidence: WorkflowEvidence
  scope: Scope
  currentSpec: AssessSpecExact['proposed'] | null
  identityAllocations: AssessSpecExact['identityAllocations'] | null
  target:
    | { status: 'issue'; scope: Scope; issue: { number: number } }
    | { status: 'pull-request'; scope: Scope; pullRequest: { pr: number; head: string; base: string; branch: string } }
  gh: Gh
  cwd: string
  uw: UwOperations | undefined
  git: GitRunner
  recovery?: { request: UwActionRequest; prepared: PreparedUwAction }
}

export type ReceiptStartContext = {
  mandateHistory: History
  mandateScope: Scope
  operationId: string
}

export function receiptStartContext(input: ModelReceiptActionInput): ReceiptStartContext {
  return {
    mandateHistory: input.mandateHistory ?? input.history,
    mandateScope: { repository: input.mandate.repository, target: input.mandate.target },
    operationId: input.recovery?.request.actionId ?? randomUUID(),
  }
}

function receiptOperandsMatch(input: Parameters<typeof sealReceipt>[0]): boolean {
  const operands = input.prepared.inputs.manifest.operands
  if (input.action === 'assess-spec') {
    return (
      operands?.action === input.action &&
      canonicalActionOperands(operands) ===
        canonicalActionOperands({ action: input.action, origin: input.origin, exactInputs: input.exactInputs })
    )
  }
  if (input.action === 'attribute-ci') {
    return (
      operands?.action === input.action &&
      canonicalActionOperands(operands) ===
        canonicalActionOperands({ action: input.action, exactInputs: input.exactInputs })
    )
  }
  return true
}

export async function sealReceipt(
  input: {
    loaded: Contracts
    history: History
    scope: Scope
    cwd: string
    gh: Gh
    parents: readonly History[]
    operationId: string
    mandate: { scope: Scope; recordId: string; kind: 'mandate' }
    prepared: PreparedUwAction
  } & (
    | { action: 'assess-spec'; origin: AssessmentProposalOrigin; exactInputs: AssessSpecExact }
    | { action: 'attribute-ci'; exactInputs: CiExact; native: { branch: string; base: string } }
    | { action: 'implement'; exactInputs: { mandateId: string; planActionId: string } }
    | { action: 'integrate'; exactInputs: { mandateId: string; planActionId: string } }
  ),
): Promise<ContinueFeatureResult> {
  const operands = input.prepared.inputs.manifest.operands
  if (!receiptOperandsMatch(input)) return blocks('action-input-changed')
  const startId = randomUUID()
  const base = {
    format: 'omp-build-action-receipt/2' as const,
    phase: 'start' as const,
    actionId: input.operationId,
    mandate: input.mandate,
    inputs: input.prepared.inputs,
  }
  let payload: Extract<ActionReceiptPayload, { phase: 'start' }>
  if (input.action === 'implement') {
    payload = { ...base, action: input.action, exactInputs: input.exactInputs }
  } else if (input.action === 'integrate') {
    payload = { ...base, action: input.action, exactInputs: input.exactInputs }
  } else if (input.action === 'assess-spec' && operands?.action === 'assess-spec') {
    payload = { ...base, action: input.action, exactInputs: operands.exactInputs }
  } else if (input.action === 'attribute-ci' && operands?.action === 'attribute-ci') {
    payload = { ...base, action: input.action, exactInputs: operands.exactInputs }
  } else {
    return blocks('action-input-changed')
  }
  const started = await publishRecord(
    input.loaded,
    input.history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: startId,
      runId: randomUUID(),
      operationId: input.operationId,
      kind: 'action-receipt',
      payload,
    },
    input.gh,
    input.cwd,
    input.parents,
  )
  if (!started.ok) return { kind: 'blocked', reason: started.reason, diagnostics: started.diagnostics }
  const confirmed = await confirmStartReadback({
    read: async (scopes) => {
      const reread = await input.loaded.readComposedWorkflowHistory(
        input.action === 'attribute-ci' ? [...scopes, input.mandate.scope] : scopes,
        { cwd: input.cwd, gh: input.gh },
      )
      if (!reread.ok || input.action !== 'attribute-ci') return reread
      return ciStartReadbackMatches(input, reread.histories) ? reread : { ok: false }
    },
    scope: input.scope,
    recordId: startId,
    inputs: input.prepared.inputs,
  })
  if (!confirmed.ok) return blocks(confirmed.reason)
  return preparedModelAction({
    action: input.action,
    scope: input.scope,
    start: { scope: input.scope, recordId: startId, kind: 'action-receipt' },
    operationId: input.operationId,
    prepared: input.prepared,
  })
}

function ciMandateCurrent(mandate: { scope: Scope; recordId: string }, histories: readonly History[]): boolean {
  const mandateHistory = historyFor(mandate.scope, histories)
  if (mandateHistory === null) return false
  const currentMandate = currentAccountedMandate(mandateHistory)
  if (
    !currentMandate.ok ||
    currentMandate.value.recordId !== mandate.recordId ||
    currentMandate.value.repository !== mandate.scope.repository ||
    currentMandate.value.target !== mandate.scope.target
  )
    return false
  return (
    outstandingPauseRequest(mandateHistory, currentMandate.value) === null &&
    unliftedPause(mandateHistory, currentMandate.value) === null
  )
}

function ciStartReadbackMatches(
  input: Extract<Parameters<typeof sealReceipt>[0], { action: 'attribute-ci' }>,
  histories: readonly History[],
): boolean {
  const subject = input.prepared.inputs.manifest.subject
  if (subject.kind !== 'uw' || subject.binding === null) return false
  if (!ciMandateCurrent(input.mandate, histories)) return false
  const selected = selectWorkflowBinding({ pullRequest: input.scope, histories, native: input.native })
  if (selected.status !== 'bound' || canonicalValueDigest(selected.mandate) !== canonicalValueDigest(input.mandate))
    return false
  const binding = sourceRef(histories, {
    scope: input.scope,
    kind: 'workflow-binding',
    recordId: selected.binding.recordId,
  })
  return binding.ok && canonicalValueDigest(binding.value) === canonicalValueDigest(subject.binding)
}
