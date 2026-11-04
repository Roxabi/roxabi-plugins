import { expect, it } from 'vitest'
import { sisterRecords } from '../../testing/cause-input-fixture.ts'
import { validateCausePublication } from '../cause-publication-validation.ts'
import { history } from './workflow-test-support.ts'

it('does not grant historical publication semantics to a live sister creation', () => {
  const { held, operation } = sisterRecords()
  const own = history([held])
  const diagnostics = validateCausePublication({ record: operation, history: own, externalHistories: [] })
  expect(diagnostics.length).toBeGreaterThan(0)
})
