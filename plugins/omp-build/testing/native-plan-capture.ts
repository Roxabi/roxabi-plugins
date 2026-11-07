import { captureSubagentEvent } from '../omp/review-runtime/capture.ts'
import { captureChildResult, groundCapturedChildren } from '../omp/review-runtime/child-capture.ts'
import type { Json, NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { HostGitIdentity } from '../omp/review-runtime/host-git-observation.ts'
import { createActiveBatch } from '../omp/review-runtime/state.ts'

/** Capture the independently submitted model judgments for every declared task. */
export async function captureNativePlanBatch(input: {
  batch: NativeBatch
  cwd: string
  git: HostGitIdentity
  claims: readonly { task: string; childId: string; value: Json }[]
}): Promise<NativeBatchResult> {
  if (
    new Set(input.claims.map((claim) => claim.task)).size !== input.claims.length ||
    new Set(input.claims.map((claim) => claim.childId)).size !== input.claims.length ||
    input.claims.some((claim) => !input.batch.tasks.tasks.some((task) => task.name === claim.task))
  )
    throw new Error('Native plan claims must identify distinct declared tasks and children')
  const active = createActiveBatch(
    input.batch,
    { onComplete: async () => {}, onStop: async () => {} },
    input.cwd,
    null,
    () => input.git,
  )
  const captured = input.batch.tasks.tasks.flatMap((task, slot) => {
    const claim = input.claims.find((entry) => entry.task === task.name)
    if (!claim) return []
    active.childSlots.set(claim.childId, slot)
    captureSubagentEvent(
      active,
      {
        id: claim.childId,
        event: {
          type: 'tool_execution_start',
          toolName: 'yield',
          toolCallId: `${claim.childId}-yield`,
          args: { data: claim.value },
        },
      },
      true,
    )
    return [
      captureChildResult(
        active,
        { id: claim.childId, exitCode: 0, structuredOutput: { status: 'valid', data: claim.value } },
        task.name,
        claim.childId,
      ),
    ]
  })
  const children = await groundCapturedChildren(active, captured)
  if (
    children.length !== input.claims.length ||
    children.some((child) => !child.usable || (child.commandRuns?.length ?? 0) !== 0)
  )
    throw new Error(`Native plan capture refused: ${JSON.stringify(children)}`)
  return {
    batch: input.batch,
    children,
    raw: children.map((child) => child.raw),
    complete: children.length === input.batch.tasks.tasks.length,
  }
}
