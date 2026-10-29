import { missingContextOf, producerOutputValid } from '../../dist/contracts.js'
import { nativeFeatureProfiles } from '../../roxabi/native-feature-profiles.ts'
import { nativeReviewProfiles } from '../../roxabi/native-review-profiles.ts'
import { hostActionBinding } from './action-registry.ts'
import type { NativeBatch, NativeChildResult } from './contracts.ts'

/** Interpret only a whole, role-valid SDK result matched to its registered host action. */
export function contextNegativeChildren(
  batch: NativeBatch,
  children: readonly NativeChildResult[],
): { children: NativeChildResult[]; invalidBinding: boolean } {
  let invalidBinding = false
  const annotated = children.map((child, index) => {
    const task = batch.tasks.tasks[index]
    if (!child.usable || task === undefined || child.expectedId !== task.name) return child
    const profile = [...nativeFeatureProfiles, ...nativeReviewProfiles].find(
      (candidate) => candidate.name === task.agent,
    )
    if (profile === undefined || !producerOutputValid(profile.output, child.structured)) return child
    const missing = missingContextOf(child.structured)
    if (missing === null) return child
    const action = hostActionBinding(task.action.snapshot, task.action.inputs)
    if (action === null) {
      invalidBinding = true
      return child
    }
    return { ...child, contextBlock: { missing, action } }
  })
  return { children: annotated, invalidBinding }
}
