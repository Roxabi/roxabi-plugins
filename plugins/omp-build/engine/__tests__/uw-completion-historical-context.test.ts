import { expect, test } from 'vitest'
import { assessUwCompletion } from '../uw-completion.ts'
import { scopeKey } from '../uw-graph.ts'
import { projectUwWaits } from '../uw-waits.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import { createHistoricalAcceptedSpecContext } from '../workflow-context-succession-inspection.ts'
import { deliveredLeaf } from './uw-delivery-proof-fixture.ts'

test('completion and wait projection retain historical refusal for changed observations and foreign contexts', async () => {
  const fixture = await deliveredLeaf()
  const original = fixture.observation
  const changedHistories = structuredClone(original.histories)
  const changedHome = changedHistories.find((entry) => entry.source.scope.target === fixture.uw.target)
  const comment = changedHome?.source.comments[0]
  if (!comment) throw new Error('Native issue history comment unavailable')
  comment.locator += ':changed-observation'
  const changed = { ...original, histories: changedHistories }
  const originalContext = createHistoricalAcceptedSpecContext(original.histories)
  const changedContext = createHistoricalAcceptedSpecContext(changed.histories)
  if (!originalContext.ok || !changedContext.ok) throw new Error('Historical contexts unavailable')
  const key = scopeKey(fixture.uw)
  expect(assessUwCompletion(original, undefined, originalContext.value).completions.get(key)?.state).toBe('complete')
  expect(assessUwCompletion(changed).completions.get(key)?.state).toBe('complete')
  for (const [observation, context] of [
    [changed, originalContext.value],
    [original, changedContext.value],
  ] as const) {
    const refused = resolveAcceptedSpec(fixture.mandate, observation.histories, undefined, undefined, context)
    if (refused.ok || refused.evidence.length === 0) throw new Error('Mismatched context was not refused')
    const waits = projectUwWaits({ ...observation, historical: context })
    expect(waits.diagnostics).toEqual(
      expect.arrayContaining(
        refused.evidence.map((diagnostic) =>
          expect.objectContaining({ code: diagnostic.code, message: diagnostic.message }),
        ),
      ),
    )
    const completion = assessUwCompletion(observation, undefined, context).completions.get(key)
    expect(completion).toMatchObject({
      state: 'indeterminate',
      diagnostics: expect.arrayContaining([
        expect.objectContaining({
          code: refused.reason,
          message: refused.evidence.map((item) => item.message).join('; '),
        }),
      ]),
    })
  }
})
