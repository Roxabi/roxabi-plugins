import { buildRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { MandateRecord } from '../workflow-control.ts'
import { must } from './workflow-test-support.ts'

export function implementationStart(mandate: MandateRecord, actionId: string, planActionId: string) {
  return must(
    buildRecord({
      version: 1,
      repository: mandate.repository,
      target: mandate.target,
      recordId: `${actionId}-start`,
      runId: 'run-1',
      operationId: `op-${actionId}-start`,
      kind: 'action-receipt',
      payload: {
        phase: 'start',
        action: 'implement',
        actionId,
        mandate: {
          scope: { repository: mandate.repository, target: mandate.target },
          recordId: mandate.recordId,
          kind: 'mandate',
        },
        exactInputs: { mandateId: mandate.recordId, planActionId },
      },
    }),
  )
}

export function implementationResult(
  mandate: MandateRecord,
  start: CanonicalRecord,
  actionId: string,
  planActionId: string,
  admitted: boolean,
) {
  const sha = 'a'.repeat(40)
  return must(
    buildRecord({
      version: 1,
      repository: mandate.repository,
      target: mandate.target,
      recordId: `${actionId}-result`,
      runId: 'run-1',
      operationId: `op-${actionId}-result`,
      kind: 'action-receipt',
      payload: {
        phase: 'result',
        action: 'implement',
        actionId,
        mandate: {
          scope: { repository: mandate.repository, target: mandate.target },
          recordId: mandate.recordId,
          kind: 'mandate',
        },
        start: {
          scope: { repository: start.repository, target: start.target },
          recordId: start.recordId,
          kind: 'action-receipt',
        },
        exactInputs: { mandateId: mandate.recordId, planActionId },
        native: admitted
          ? { completion: 'completed', strict: 'valid', raw: null }
          : { completion: 'incomplete', strict: 'invalid', raw: null },
        structured: admitted
          ? {
              outcome: 'implemented',
              commitSHAs: [sha],
              commands: [{ toolCallId: 'call-implement', command: 'bun test', exitCode: 0 }],
              proofToolCallId: 'call-proof',
              proofUnavailableReason: null,
              reason: 'implemented',
            }
          : null,
        admission: {
          admitted,
          commits: admitted ? [sha] : [],
          paths: admitted ? ['src/feature.ts'] : [],
          commands: admitted ? [{ toolCallId: 'call-implement', command: 'bun test', exitCode: 0, cwd: '/work' }] : [],
          remoteBranch: admitted ? 'feature/bounded' : null,
          remoteTip: admitted ? sha : null,
          published: false,
          reason: admitted ? 'admitted' : 'not admitted',
        },
        diagnostics: [],
      },
    }),
  )
}
