import { featureMandate, pullHistory } from './feature-ci-review-fixture.ts'
import type { createRecoveryTestRoot } from './fix-recovery-real-root.ts'
import type { Box } from './sandbox/sandbox-types.ts'

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

export function nextAdoptionBatch(messages: unknown, used: ReadonlySet<string>): string | undefined {
  for (const text of strings(messages)) {
    const match = /OMP_BUILD_NATIVE_BATCH:\s*(\{[^\n]+\})/.exec(text)
    if (!match) continue
    try {
      const value: unknown = JSON.parse(match[1] ?? '{}')
      if (
        value &&
        typeof value === 'object' &&
        'batchId' in value &&
        typeof value.batchId === 'string' &&
        !used.has(value.batchId)
      )
        return value.batchId
    } catch {
      /* A partial stream is not an announcement. */
    }
  }
  return undefined
}

export function adoptionRecoveryReport(input: {
  label: string
  root: Awaited<ReturnType<typeof createRecoveryTestRoot>>
  box: Box
  recoveryCalled: boolean
  used: ReadonlySet<string>
  notifications: string[]
  nativeErrors: string[]
}): string {
  const { label, root, box, recoveryCalled, used, notifications, nativeErrors } = input
  const summarize = (history: ReturnType<typeof pullHistory>) =>
    history.operations.map((operation) => ({
      status: operation.status,
      kind: operation.kind,
      operationId: operation.operationId,
      recordId: operation.recordId,
      runId: operation.record?.runId,
      authority: operation.authority,
    }))
  const results = root.session.messages
    .filter((message) => message.role === 'toolResult' || message.role === 'custom')
    .map((message) => JSON.stringify(message).slice(0, 1500))
  return `${label}:${JSON.stringify({
    recoveryCalled,
    used: [...used],
    results,
    notifications,
    nativeErrors,
    nativeDispatches: root.nativeDispatches,
    children: root.children,
    issue: summarize(featureMandate(box).history),
    pull: summarize(pullHistory(box)),
  })}`
}
