import { describe, expect, it } from 'vitest'
import { selectApplicableMandate } from '../../engine/workflow-mandate-admission.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import { SCOPE } from './support/workflow-decision-fixtures.ts'

const { featureMandate, historyFrom } = roxabiWorkflowFixtures()

describe('workflow mandate selection', () => {
  it('refuses a second unrelated mandate instead of picking either', () => {
    const first = featureMandate(SCOPE, { recordId: 'mandate-a', operationId: 'op-mandate-a' })
    const second = featureMandate(SCOPE, {
      recordId: 'mandate-b',
      operationId: 'op-mandate-b',
      branch: 'feat/42-other',
    })
    expect(selectApplicableMandate(historyFrom([first, second]))).toMatchObject({
      status: 'refused',
      reason: 'ambiguous',
    })
  })
})
