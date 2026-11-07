import { consultableAgentRoot } from '../../testing/protocol-retention.unit.ts'
import { fixtureAction } from '../../testing/review-runtime-support.ts'
import type { NativeBatch } from '../review-runtime/contracts.ts'

export const root = {
  ...consultableAgentRoot(),
  cwd: '/repo/feature',
  model: { contextWindow: 128_000 },
  isIdle: () => true,
}

export function batch(operationId = 'feature-op'): NativeBatch {
  return {
    operationId,
    tasks: {
      context: 'feature fixture',
      tasks: [
        {
          name: 'R-workflow-plan',
          agent: 'R-advisor',
          task: 'plan',
          solutionSpace: 'fixed fixture',
          action: fixtureAction('R-workflow-plan'),
        },
      ],
    },
  }
}
