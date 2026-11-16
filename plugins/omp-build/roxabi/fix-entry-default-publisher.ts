import type { GitHubOptions, Scope } from '../dist/contracts.js'
import { decodeHistory, readGitHubHistory } from '../dist/contracts.js'
import type { FixActionResult, RecordPublisher } from './fix-contract.ts'
import { fail } from './fix-entry-target-core.ts'
import type { FixWorkflowRuntime } from './fix-native-dispatch.ts'
import { createGitHubRecordPublisher } from './github-publisher'

export function createDefaultPublisher(
  scope: Scope,
  github: GitHubOptions,
  runtime: FixWorkflowRuntime,
  originalScope: () => Scope | null,
): RecordPublisher {
  const rawPublisher = createGitHubRecordPublisher(scope, github, null)
  return {
    publish: (record, canPublish) => {
      const publishRecord = async (): Promise<FixActionResult<void>> => {
        const mayPublish = () => (canPublish?.() ?? true) && (runtime.executionFence?.rootCurrent() ?? true)
        if (!mayPublish()) return fail('publication-ownership-revoked')
        const original = originalScope()
        const external =
          original !== null && (original.repository !== scope.repository || original.target !== scope.target)
            ? [decodeHistory(await readGitHubHistory(original, github))]
            : []
        const saved = await rawPublisher.publish(record, external, mayPublish)
        return saved.ok ? { ok: true, value: undefined } : saved
      }
      return runtime.executionFence === undefined
        ? publishRecord()
        : runtime.executionFence.trackPublication(record, publishRecord)
    },
  }
}
