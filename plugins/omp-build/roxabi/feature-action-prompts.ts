import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import { type DeliveryTask, deliveryBatch, deliveryTask } from './delivery-action.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'

export type PreparedModelAction = {
  action: 'attribute-ci' | 'assess-spec' | 'implement' | 'integrate'
  scope: Scope
  start: ScopedRecordRef
  operationId: string
  prepared: PreparedUwAction
}

const PROCEDURE = {
  'assess-spec':
    'Compare the exact accepted and proposed states in the action index, including the own Spec, full ancestor vector, inherited invariants and exclusions, engaged and proposed children, created-by slot and its sealed plan, and coverage. Classify the change as editorial, material, or unknown. Return structured compatibility judgments that exhaustively examine the applicable qualified constraints, identify conflicts or uncertainty, and cite the exact captured evidence supporting each judgment. Preserve slot identities and cite only sources in the action inputs.',
  'attribute-ci':
    'Attribute the failing checks named by the index to change, pre-existing, infra, unknown, or out-of-scope. Done when attribution is one of those values and evidence cites the check plus the scope fact that supports it. Do not implement a repair.',
  implement:
    'Implement the confirmed plan named by the index. Return one declaration per accepted criterion: admissible evidence or unverified with a concrete reason. Command claims contain only toolCallId, command, and exitCode. Do not invent captured output or a code SHA. Done when outcome is implemented or blocked and every accepted criterion is declared.',
  integrate:
    'Integrate the completed children into the pinned parent candidate. Return the actual observed parent code range, each direct child Spec and code proof with its canonical sources, accepted coverage, commands, and one declaration per parent criterion. An already-integrated candidate is valid without a new commit. Never invent evidence, code, or commits; report missing context when proof is unavailable.',
} as const

export function preparedModelAction(input: PreparedModelAction): ContinueFeatureResult {
  const task = deliveryTask({
    name: actionAgent(input.action),
    agent: actionAgent(input.action),
    procedure: PROCEDURE[input.action],
    solutionSpace: 'one named workflow action; no second review loop',
    prepared: input.prepared,
  })
  return {
    kind: 'action',
    node: input.action,
    start: input.start,
    followUp: deliveryBatch(input.operationId, [task]),
  }
}

export function preparedTasks(operationId: string, tasks: readonly DeliveryTask[]): NativeBatch {
  return deliveryBatch(operationId, tasks)
}

function actionAgent(action: PreparedModelAction['action']): string {
  if (action === 'assess-spec') return 'R-workflow-assess-spec'
  if (action === 'attribute-ci') return 'R-workflow-attribute-ci'
  return 'R-workflow-implement'
}
