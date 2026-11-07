import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import type { ActionInputs } from '../action-input-schema.ts'
import { buildRecord } from '../record-construction.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { MandateRecord } from '../workflow-control.ts'
import { ACTION_RECEIPT_FORMAT } from '../workflow-receipt-schema.ts'
import { must } from './workflow-test-support.ts'

export function implementationStart(
  mandate: MandateRecord,
  actionId: string,
  planActionId: string,
  codeRange?: ActionInputs['manifest']['code'],
) {
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
        format: ACTION_RECEIPT_FORMAT,
        inputs: acceptedActionInputs(mandate, 'implement', undefined, codeRange),
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

export function rejectedImplementationResult(
  mandate: MandateRecord,
  start: CanonicalRecord,
  actionId: string,
  planActionId: string,
  codeRange?: ActionInputs['manifest']['code'],
) {
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
        format: ACTION_RECEIPT_FORMAT,
        inputs: acceptedActionInputs(mandate, 'implement', undefined, codeRange),
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
        native: { completion: 'incomplete', strict: 'invalid', raw: null },
        structured: null,
        admission: {
          admitted: false,
          commits: [],
          paths: [],
          commands: [],
          remoteBranch: null,
          remoteTip: null,
          published: false,
          reason: 'not admitted',
        },
        diagnostics: [],
      },
    }),
  )
}
