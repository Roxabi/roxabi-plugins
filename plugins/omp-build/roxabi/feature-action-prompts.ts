import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { NativeBatch } from '../omp/review-runtime/contracts.ts'
import { type DeliveryTask, deliveryBatch, deliveryTask } from './delivery-action.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'

export type PreparedModelAction = {
  action: 'attribute-ci' | 'assess-spec' | 'implement'
  scope: Scope
  start: ScopedRecordRef
  operationId: string
  prepared: PreparedUwAction
}

const PROCEDURE = {
  'assess-spec':
    'Compare the accepted and proposed Spec files named by the index. Classify the pair as editorial, material, or unknown. Done when classification is exactly one of those three values.',
  'attribute-ci':
    'Attribute the failing checks named by the index to change, pre-existing, infra, unknown, or out-of-scope. Done when attribution is one of those values and evidence cites the check plus the scope fact that supports it. Do not implement a repair.',
  implement:
    'Implement the confirmed plan named by the index. Return one declaration per accepted criterion: admissible evidence or unverified with a concrete reason. Command claims contain only toolCallId, command, and exitCode. Do not invent captured output or a code SHA. Done when outcome is implemented or blocked and every accepted criterion is declared.',
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
