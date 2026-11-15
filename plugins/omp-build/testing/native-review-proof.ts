import { spawnSync } from 'node:child_process'
import type { NativeTask } from '../omp/review-runtime/contracts.ts'
import type { NativeReviewChild } from './native-review-child.ts'

type Proof = { command: string; args: string[]; program?: string; restore?(): void }

/** Execute and report a child proof through the same tool-call and lifecycle events as the host. */
export async function captureNativeReviewProof(
  proof: Proof | undefined,
  cwd: string,
  task: NativeTask,
  child: NativeReviewChild,
  emit: (event: unknown) => Promise<void>,
): Promise<void> {
  if (proof === undefined) return
  const toolCallId = `${task.name}-proof`
  await child.call('bash', toolCallId, { command: proof.command })
  await emit({
    id: task.name,
    event: { type: 'tool_execution_start', toolName: 'bash', toolCallId, args: { command: proof.command } },
  })
  const execution = spawnSync(proof.program ?? 'git', proof.args, { cwd, encoding: 'utf8' })
  proof.restore?.()
  if (execution.error) throw execution.error
  if (execution.status === null) throw new Error(`proof terminated by signal: ${execution.signal}`)
  const exitCode = execution.status
  const content = [{ type: 'text', text: `${execution.stdout}${execution.stderr}` }]
  await child.result(
    'bash',
    toolCallId,
    { command: proof.command },
    {
      content,
      details: { exitCode },
      isError: exitCode !== 0,
    },
  )
  await emit({
    id: task.name,
    event: {
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId,
      isError: exitCode !== 0,
      result: { content, details: { exitCode } },
    },
  })
}
