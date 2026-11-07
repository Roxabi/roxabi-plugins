import { expect, it } from 'vitest'
import { nextStep } from './epic-next-step'
import { DONE, facts } from './epic-transition.fixture'
import { epicStepName } from './epic-types'

it('routes completed children without an admitted Parent integration to the existing integration prerequisite', () => {
  const step = nextStep(facts(DONE.map((child) => ({ ...child, completion: 'complete' }))))
  expect(step.action).toBe('integrate')
  expect(epicStepName(step)).toBeNull()
})

it('holds unreadable Parent integration instead of interpreting it as absence or approval', () => {
  const step = nextStep(
    facts(
      DONE.map((child) => ({ ...child, completion: 'complete' })),
      {
        parentIntegration: {
          ok: false,
          diagnostics: [
            {
              code: 'record-unreadable',
              message: 'integration history unavailable',
              location: { kind: 'native', uw: { repository: 'o/r', target: 'o/r#575' }, connection: 'state' },
              related: [],
            },
          ],
        },
      },
    ),
  )
  expect(step).toMatchObject({ action: 'drop', stop: 'driver-error', reason: 'integration history unavailable' })
})
