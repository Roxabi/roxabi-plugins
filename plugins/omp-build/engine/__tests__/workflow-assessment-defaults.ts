import type { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import type { MandateRecord } from '../workflow-control.ts'
import { SCOPE } from './workflow-test-support.ts'

export function buildShippedFeatureMandate(workflowFixtures: ReturnType<typeof roxabiWorkflowFixtures>): MandateRecord {
  return workflowFixtures.featureMandate(SCOPE, {
    recordId: 'mandate-1',
    runId: 'run-1',
    operationId: 'op-mandate-1',
    branch: 'feature/bounded',
    base: 'main',
    lineageHead: null,
    body: 'ship the bounded workflow',
  })
}
