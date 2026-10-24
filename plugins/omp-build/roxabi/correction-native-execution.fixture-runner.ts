import type { NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.js'
import type {
  CorrectionActionBinding,
  CorrectionEffectResult,
  NativeCorrectionPort,
} from './correction-execution-contract'
import { createNativeCorrectionExecution } from './correction-native-execution'
import type { Continuation, Workspace } from './correction-native-execution.fixture-world'

export function executor(
  fixture: Workspace,
  port: NativeCorrectionPort,
  operation = 'operation-1',
  bindings: CorrectionActionBinding[] = [],
  conserved: NativeBatchResult[] = [],
  continuation: Continuation = { signal: new AbortController().signal },
) {
  return createNativeCorrectionExecution({
    native: port,
    prepared: {
      cwd: fixture.cwd,
      target: {
        repository: 'Acme/app',
        target: 'Acme/app#42',
        number: 42,
        kind: 'pull-request',
        state: 'open',
        candidateGitSHA: fixture.head,
      },
      publishBinding: fixture.binding,
    },
    operationId: operation,
    decisionId: 'decision-1',
    signal: continuation.signal,
    authorizeContinuation: continuation.authorizeContinuation,
    async bindAction(binding): Promise<
      CorrectionEffectResult<{
        batch: NativeBatch
        conserve(result: NativeBatchResult): Promise<CorrectionEffectResult<{ contributionIds: string[] }>>
      }>
    > {
      bindings.push(binding)
      const batch: NativeBatch = {
        operationId: operation,
        tasks: { context: binding.task.task, tasks: [binding.task] },
      }
      return {
        ok: true,
        value: {
          batch,
          async conserve(result) {
            conserved.push(result)
            return { ok: true, value: { contributionIds: [result.batch.tasks.tasks[0]?.name ?? 'missing'] } }
          },
        },
      }
    },
    async onStarted() {
      return { ok: true, value: undefined }
    },
  })
}
