import { bridgeHarness, root } from '../omp/__tests__/review-runtime-support.ts'
import type { NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.ts'

export const INCOMPLETE_NATIVE_TERMINAL = {
  index: 0,
  id: 'R-workflow-implement',
  agent: 'R-workflow-implement',
  exitCode: 1,
  structuredOutput: { status: 'invalid', data: { refusal: 'incomplete-native' } },
}

export async function observedIncompleteNativeResult(batch: NativeBatch): Promise<NativeBatchResult> {
  const harness = bridgeHarness()
  let settled: NativeBatchResult | null = null
  harness.controller.activate(batch, {
    onComplete: async (result) => {
      settled = result
    },
    onStop: async (_reason, result) => {
      settled = result
    },
  })
  const task = batch.tasks.tasks[0]
  const wire = harness.controller.wire(batch)
  if (task === undefined || wire === null) throw new Error('observed-native-batch-unwired')
  await harness.emitBridge('tool_call', { toolName: 'task', toolCallId: batch.operationId, input: wire }, root)
  await harness.emitBridge(
    'before_subagent_spawn',
    { agent: task.agent, invocationKind: 'task', patterns: [], spawnKey: task.name },
    root,
  )
  harness.emitRaw({
    id: task.name,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'incomplete native child output' },
    },
  })
  harness.emitRaw({
    id: task.name,
    event: {
      type: 'tool_execution_start',
      toolName: 'yield',
      toolCallId: 'incomplete-yield',
      args: { data: { outcome: 'incomplete', provenance: 'native' } },
    },
  })
  await harness.emitBridge(
    'tool_result',
    {
      toolName: 'task',
      toolCallId: batch.operationId,
      isError: true,
      content: [],
      details: { results: [{ ...INCOMPLETE_NATIVE_TERMINAL, id: task.name, agent: task.agent }] },
    },
    root,
  )
  if (settled === null) throw new Error('observed-native-result-missing')
  return settled
}
