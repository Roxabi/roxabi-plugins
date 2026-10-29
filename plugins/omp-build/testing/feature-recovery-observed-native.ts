import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { bridgeHarness, root } from './review-runtime-support.ts'

export const INCOMPLETE_NATIVE_TERMINAL = {
  index: 0,
  id: 'R-workflow-implement',
  agent: 'R-workflow-implement',
  exitCode: 1,
  structuredOutput: { status: 'invalid', data: { refusal: 'incomplete-native' } },
}

export async function observedIncompleteNativeResult(batch: NativeBatch, cwd: string): Promise<NativeBatchResult> {
  const artifacts = mkdtempSync(join(tmpdir(), 'recovery-observed-'))
  const scenario = {
    ...root,
    cwd,
    localProtocolOptions: { getArtifactsDir: () => artifacts },
  }
  const harness = bridgeHarness()
  try {
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
    if (!(await harness.admitBatch(batch, batch.operationId, scenario)))
      throw new Error('observed-native-admission-refused')
    const child = await harness.admitChild(batch, task.name, task.name, {
      root: scenario,
      toolCallId: batch.operationId,
      skipRootCall: true,
    })
    await child.message({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'incomplete native child output' },
    })
    await child.call('yield', 'incomplete-yield', { data: { outcome: 'incomplete', provenance: 'native' } })
    await harness.settleBatch({
      toolCallId: batch.operationId,
      errors: ['incomplete-native'],
      results: [{ ...INCOMPLETE_NATIVE_TERMINAL, id: task.name, agent: task.agent }],
    })
    if (settled === null) throw new Error('observed-native-result-missing')
    return settled
  } finally {
    rmSync(artifacts, { recursive: true, force: true })
  }
}
