import type { Result } from '../engine/result.ts'
import type {
  ActionInputs,
  CorrectionRootRef,
  PreparedUwAction,
  SelectedReview,
  UwActionPorts,
  UwActionRequest,
} from './uw-action-contract.ts'
import { prepareUwAction, replayUwActionInputs } from './uw-action-inputs.ts'
import { actionFailure } from './uw-action-result.ts'
import type { UwOperations } from './uw-contract.ts'
import { readUwDelivery, type UwDeliveryReadPorts } from './uw-delivery-read.ts'

export type ActionOperationPorts = {
  actions?: UwActionPorts
  delivery?: UwDeliveryReadPorts
}

export function actionOperationMethods(
  ports: ActionOperationPorts,
): Pick<UwOperations, 'prepareAction' | 'replayActionInputs' | 'readDelivery'> {
  const missing = (): Promise<Result<never>> =>
    Promise.resolve(actionFailure('action-input-missing', 'Action ports are not installed'))
  return {
    prepareAction: (
      input: UwActionRequest,
      review?: SelectedReview,
      correctionRoot?: CorrectionRootRef,
    ): Promise<Result<PreparedUwAction>> =>
      ports.actions === undefined ? missing() : prepareUwAction(input, ports.actions, review, correctionRoot),
    replayActionInputs: (input: {
      reviewed: ActionInputs
      request: UwActionRequest
      reviewedRoot?: SelectedReview['root']
      correctionRoot?: CorrectionRootRef
    }): Promise<Result<ActionInputs>> =>
      ports.actions === undefined ? missing() : replayUwActionInputs(input, ports.actions),
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
