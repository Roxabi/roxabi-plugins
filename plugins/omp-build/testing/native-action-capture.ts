import { captureSubagentEvent } from '../omp/review-runtime/capture.ts'
import { captureChildResult, groundCapturedChildren } from '../omp/review-runtime/child-capture.ts'
import type { Json, NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import type { HostGitIdentity } from '../omp/review-runtime/host-git-observation.ts'
import { createActiveBatch } from '../omp/review-runtime/state.ts'

/** Feed a declared simulated task's actual events through the production capture and grounding path. */
export async function captureNativeTask(input: {
  batch: NativeBatch
  cwd: string
  childId: string
  command: string
  toolCallId: string
  output: string
  claim: Json
  /** Only command references present in the structured claim are retained by grounding. */
  expectedRuns: 0 | 1
  git: HostGitIdentity
}): Promise<NativeBatchResult> {
  const task = input.batch.tasks.tasks[0]
  if (!task || input.batch.tasks.tasks.length !== 1) throw new Error('Expected exactly one native task')
  const active = createActiveBatch(
    input.batch,
    { onComplete: async () => {}, onStop: async () => {} },
    input.cwd,
    null,
    () => input.git,
  )
  active.childSlots.set(input.childId, 0)
  captureSubagentEvent(
    active,
    {
      id: input.childId,
      event: {
        type: 'tool_execution_start',
        toolName: 'bash',
        toolCallId: input.toolCallId,
        args: { command: input.command },
      },
    },
    true,
  )
  captureSubagentEvent(
    active,
    {
      id: input.childId,
      event: {
        type: 'tool_execution_end',
        toolName: 'bash',
        toolCallId: input.toolCallId,
        isError: false,
        result: { content: [{ type: 'text', text: input.output }], details: { exitCode: 0 } },
      },
    },
    true,
  )
  captureSubagentEvent(
    active,
    {
      id: input.childId,
      event: {
        type: 'tool_execution_start',
        toolName: 'yield',
        toolCallId: `${input.childId}-yield`,
        args: { data: input.claim },
      },
    },
    true,
  )
  const terminal = { id: input.childId, exitCode: 0, structuredOutput: { status: 'valid', data: input.claim } }
  const captured = captureChildResult(active, terminal, task.name, input.childId)
  const [child] = await groundCapturedChildren(active, [captured])
  if (
    !child?.usable ||
    child.commandRuns?.length !== input.expectedRuns ||
    (input.expectedRuns === 1 && !child.nativeProvenance)
  )
    throw new Error(`Native task capture refused: ${JSON.stringify(child)}`)
  return { batch: input.batch, children: [child], raw: terminal, complete: true }
}
