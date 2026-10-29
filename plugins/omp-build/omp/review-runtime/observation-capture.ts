import { isDeepStrictEqual } from 'node:util'
import { hostActionBinding } from './action-registry.ts'
import { object } from './capture.ts'
import type { NativeBatch, NativeChildResult } from './contracts.ts'

/** Identify the actual matched yielded claim; semantic truth remains an independent review. */
export function bindNativeObservations(
  batch: NativeBatch,
  children: readonly NativeChildResult[],
): NativeChildResult[] {
  return children.map((child, index) => {
    const task = batch.tasks.tasks[index]
    const submission = child.submissions.at(-1)
    const raw = submission?.raw
    const execution = object(raw) && object(raw.executionArguments) ? raw.executionArguments : null
    if (
      task === undefined ||
      child.expectedId !== task.name ||
      !child.usable ||
      child.id === null ||
      child.id.length === 0 ||
      submission === undefined ||
      submission.data === null ||
      execution === null ||
      !isDeepStrictEqual(execution.data, submission.data) ||
      hostActionBinding(task.action.snapshot, task.action.inputs) === null
    )
      return child
    return {
      ...child,
      observationProvenance: {
        kind: 'native' as const,
        actionId: task.action.snapshot.actionId,
        childId: child.id,
        submissionIndex: submission.attemptIndex,
        toolCallIds: [],
      },
    }
  })
}
