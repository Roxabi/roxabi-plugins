import { isDeepStrictEqual } from 'node:util'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { NativeChildResult } from '../omp/review-runtime/contracts.ts'

/** A negative is authoritative only for the sealed action that actually ran. */
export function matchesContextNegative(child: NativeChildResult, actionId: string, inputs: ActionInputs): boolean {
  return (
    child.contextBlock !== undefined &&
    child.contextBlock.action.actionId === actionId &&
    isDeepStrictEqual(child.contextBlock.action.inputs, inputs)
  )
}
