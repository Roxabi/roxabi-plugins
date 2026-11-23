import { randomUUID } from 'node:crypto'
import { canonicalActionOperands } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { AssessmentProposalOrigin } from '../engine/workflow-action-operands.ts'
import type { ActionReceiptPayload, AssessSpecExact } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import { confirmStartReadback, deliveryBatch, deliveryTask } from './delivery-action.ts'
import { type Contracts, type History, publishRecord } from './feature-engine.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'

export type Gh = (cwd: string, args: string[]) => Promise<string>

type AssessmentStart =
  | { kind: 'action'; start: ScopedRecordRef & { kind: 'action-receipt' }; followUp: NativeBatch }
  | { kind: 'blocked'; reason: string }

export async function sealReceipt(input: {
  loaded: Contracts
  history: History
  scope: Scope
  cwd: string
  gh: Gh
  parents: readonly History[]
  operationId: string
  mandate: { scope: Scope; recordId: string; kind: 'mandate' }
  prepared: PreparedUwAction
  origin: AssessmentProposalOrigin
  exactInputs: AssessSpecExact
}): Promise<AssessmentStart> {
  const operands = input.prepared.inputs.manifest.operands
  if (
    operands?.action !== 'assess-spec' ||
    canonicalActionOperands(operands) !==
      canonicalActionOperands({ action: 'assess-spec', origin: input.origin, exactInputs: input.exactInputs })
  )
    return { kind: 'blocked', reason: 'action-input-changed' }
  const startId = randomUUID()
  const payload: Extract<ActionReceiptPayload, { phase: 'start'; action: 'assess-spec' }> = {
    format: 'omp-build-action-receipt/2',
    phase: 'start',
    action: 'assess-spec',
    actionId: input.operationId,
    mandate: input.mandate,
    inputs: input.prepared.inputs,
    exactInputs: operands.exactInputs,
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
  if (!started.ok) return { kind: 'blocked', reason: started.reason }
  const confirmed = await confirmStartReadback({
    read: (scopes) => input.loaded.readComposedWorkflowHistory(scopes, { cwd: input.cwd, gh: input.gh }),
    scope: input.scope,
    recordId: startId,
    inputs: input.prepared.inputs,
  })
  if (!confirmed.ok) return { kind: 'blocked', reason: confirmed.reason }
  const task = deliveryTask({
    name: 'R-workflow-assess-spec',
    agent: 'R-workflow-assess-spec',
    procedure:
      'Compare the exact accepted and proposed states in the action index, including the own Spec, full ancestor vector, inherited invariants and exclusions, engaged and proposed children, created-by slot and its sealed plan, and coverage. Classify the change as editorial, material, or unknown. Return structured compatibility judgments that exhaustively examine the applicable qualified constraints, identify conflicts or uncertainty, and cite the exact captured evidence supporting each judgment. Preserve slot identities and cite only sources in the action inputs.',
    solutionSpace: 'one named workflow action; no second review loop',
    prepared: input.prepared,
  })
  return {
    kind: 'action',
    start: { scope: input.scope, recordId: startId, kind: 'action-receipt' },
    followUp: deliveryBatch(input.operationId, [task]),
  }
}
