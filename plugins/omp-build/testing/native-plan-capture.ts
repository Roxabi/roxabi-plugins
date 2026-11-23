import { missingContextOutputSchema } from '../engine/action-context.ts'
import type { Json, NativeOutcome, Submission } from '../engine/record-values.ts'
import { historicalSubmission } from './native-action-capture.ts'

export type HistoricalPlanBatch = {
  operationId: string
  tasks: { tasks: { name: string }[] }
}

type PlanClaim = { task: string; childId: string; value: Json }
export type HistoricalPlanCapture = {
  children: {
    id: string
    expectedId: string
    native: NativeOutcome
    submissions: Submission[]
    structured: Json
    contextBlock: boolean
  }[]
  complete: boolean
}

export function captureNativePlanBatch(input: {
  batch: HistoricalPlanBatch
  claims: readonly PlanClaim[]
}): HistoricalPlanCapture {
  const tasks = input.batch.tasks.tasks
  if (
    new Set(input.claims.map((claim) => claim.task)).size !== input.claims.length ||
    new Set(input.claims.map((claim) => claim.childId)).size !== input.claims.length ||
    input.claims.some((claim) => !tasks.some((task) => task.name === claim.task))
  )
    throw new Error('Historical plan claims must identify distinct declared slots and children')
  const children = tasks.flatMap(({ name }) => {
    const claim = input.claims.find((entry) => entry.task === name)
    if (!claim) return []
    const { submission, native } = historicalSubmission(claim.childId, claim.value)
    return [
      {
        id: claim.childId,
        expectedId: name,
        native,
        submissions: [submission],
        structured: claim.value,
        contextBlock: missingContextOutputSchema.safeParse(claim.value).success,
      },
    ]
  })
  return { children, complete: children.length === tasks.length }
}
