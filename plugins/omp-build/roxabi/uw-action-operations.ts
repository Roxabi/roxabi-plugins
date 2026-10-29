import type { Result } from '../engine/result.ts'
import type {
  ActionInputs,
  ActionSnapshot,
  PreparedUwAction,
  ReviewActionProjection,
  UwActionPorts,
  UwActionRequest,
} from './uw-action-contract.ts'
import { prepareUwAction, replayUwActionInputs } from './uw-action-inputs.ts'
import { actionFailure } from './uw-action-result.ts'
import { prepareReviewActions } from './uw-action-review-batch.ts'
import { verifyActionSnapshot } from './uw-action-snapshot.ts'
import type { UwOperations } from './uw-contract.ts'
import { readUwDelivery, type UwDeliveryReadPorts } from './uw-delivery-read.ts'

export type ActionOperationPorts = {
  actions?: UwActionPorts
  delivery?: UwDeliveryReadPorts
}

export function actionOperationMethods(
  ports: ActionOperationPorts,
): Pick<
  UwOperations,
  'prepareAction' | 'prepareReviewActions' | 'replayActionInputs' | 'verifyAction' | 'readDelivery'
> {
  const missing = (): Promise<Result<never>> =>
    Promise.resolve(actionFailure('action-input-missing', 'Action ports are not installed'))
  return {
    prepareAction: (input: UwActionRequest, projection?: ReviewActionProjection): Promise<Result<PreparedUwAction>> =>
      ports.actions === undefined ? missing() : prepareUwAction(input, ports.actions, projection),
    prepareReviewActions: (input) =>
      ports.actions === undefined ? missing() : prepareReviewActions(input, ports.actions),
    replayActionInputs: (input: { reviewed: ActionInputs; request: UwActionRequest }): Promise<Result<ActionInputs>> =>
      ports.actions === undefined ? missing() : replayUwActionInputs(input, ports.actions),
    verifyAction: (snapshot: ActionSnapshot) => verifyActionSnapshot(snapshot),
    readDelivery: (uw) =>
      ports.delivery === undefined
        ? Promise.resolve({
            ok: false,
            diagnostics: [
              {
                code: 'action-input-missing',
                message: 'Delivery ports are not installed',
                location: { kind: 'native', uw, connection: 'state' as const },
                related: [],
              },
            ],
          })
        : readUwDelivery(uw, ports.delivery),
  }
}
