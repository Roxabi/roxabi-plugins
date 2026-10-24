import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { selectApplicableMandate } from '../../engine/workflow-mandate-admission.ts'
import { roxabiWorkflowFixtures } from '../roxabi-presets.ts'
import { BODY, blank, SCOPE } from './support/workflow-decision-fixtures.ts'

const { featureMandate } = roxabiWorkflowFixtures()

describe('workflow decision specification authority', () => {
  it('does not treat a mandate object outside the history as authority', () => {
    const held = featureMandate(SCOPE, { body: BODY })
    expect(held.kind).toBe('mandate')
    expect(selectApplicableMandate(blank(), [])).toMatchObject({ status: 'refused', reason: 'missing' })
  })

  it('pins the mandate product version to installed package metadata', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    const mandate = featureMandate(SCOPE)
    if (mandate.kind !== 'mandate') throw new Error('expected a mandate')
    expect(mandate.payload.config.productVersion).toBe(pkg.version)
  })
})
