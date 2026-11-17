import { expect } from 'vitest'
import { continueFeature } from '../../roxabi/workflow.ts'
import type { inWorld } from './workflow-captured-world-fixture.ts'

export async function expectEditedWorkRefused(
  {
    world,
    scenario,
    confirmations,
  }: Pick<Parameters<Parameters<typeof inWorld>[0]>[0], 'world' | 'scenario' | 'confirmations'>,
  recordId: string,
  nativeId: string,
  editedBody: string,
) {
  const after = await world.operations.readUw(scenario.leaf)
  expect(after.observation).toMatchObject({
    status: 'incomplete',
    diagnostics: [
      expect.objectContaining({
        code: 'legacy-coverage-incomplete',
        message: 'UW home history is incomplete or ambiguous',
      }),
    ],
  })
  const home = after.observation.histories.find((item) => item.source.scope.target === scenario.leaf.target)
  if (!home) throw new Error('Edited native history is missing')
  expect(home.source.comments.find((comment) => comment.nativeId === nativeId)?.body).toBe(editedBody)
  expect(home.operations.find((operation) => operation.recordId === recordId)).toMatchObject({ status: 'invalid' })
  expect(home.diagnostics).toContainEqual(
    expect.objectContaining({ code: 'record-edited', message: expect.stringContaining(recordId) }),
  )
  const confirmationCount = confirmations()
  const result = await continueFeature({
    cwd: world.cwd,
    reference: '202',
    control: 'continue',
    principal: false,
    git: world.git,
    gh: world.gh,
    uw: world.operations,
  })
  expect(result, JSON.stringify(result)).toMatchObject({
    kind: 'blocked',
    reason: 'fix-own-uw-unsettled',
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('legacy-coverage-incomplete') }),
    ]),
  })
  expect(confirmations()).toBe(confirmationCount)
  const reread = await world.operations.readUw(scenario.leaf)
  expect(reread.observation.histories.map((item) => item.source)).toEqual(
    after.observation.histories.map((item) => item.source),
  )
}
