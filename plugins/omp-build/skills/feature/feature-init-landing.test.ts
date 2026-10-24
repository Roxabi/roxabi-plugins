import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateLabel } from '../../../issue-triage/skills/issue-triage/lib/migrate-labels'
import { factsFor, originAcme, recordedGh, recordedParseYaml, scratchCopy } from './feature-init.fixture'
import { plan, readFacts } from './feature-init-facts'
import { applyStack } from './feature-init-stack'

describe('an existing landing', () => {
  /** `kept` in a scratch copy, its stack.yml carrying `onDisk` lines, parsed as `landing`. */
  async function keptWithLanding(landing: unknown, onDisk = '') {
    const dir = scratchCopy('kept')
    const stackPath = path.join(dir, '.dev', 'stack.yml')
    if (onDisk) {
      const text = readFileSync(stackPath, 'utf8')
      if (!text.includes('  mode: merge-on-green\n')) throw new Error('kept fixture has no merge-on-green landing')
      writeFileSync(stackPath, text.replace('  mode: merge-on-green\n', `  mode: merge-on-green\n${onDisk}`))
    }
    const stack = readFileSync(stackPath, 'utf8')
    const lefthook = recordedParseYaml('kept')
    const facts = await readFacts(dir, {
      gh: recordedGh('kept'),
      gitRemoteUrl: originAcme,
      migrateLabel,
      parseYaml: (text) => (text === stack ? { landing } : lefthook(text)),
    })
    return { dir, stack, facts }
  }

  it('flags a merge-on-green required_checks list that hides other checks, and writes nothing', async () => {
    const { dir, stack, facts } = await keptWithLanding(
      { mode: 'merge-on-green', required_checks: ['widget-build'] },
      '  required_checks: [widget-build]\n',
    )
    expect(stack).toContain('  required_checks: [widget-build]\n')
    expect(plan(facts)).toContain('landing kept (existing; required_checks hides other checks)')
    applyStack(dir, facts)
    expect(readFileSync(path.join(dir, '.dev', 'stack.yml'), 'utf8')).toBe(stack)
  })

  it.each([
    ['an empty list', { mode: 'merge-on-green', required_checks: [] }],
    ['native mode', { mode: 'native', required_checks: ['widget-build'] }],
    ['no required_checks', { mode: 'merge-on-green' }],
  ])('keeps quiet for %s', async (_row, landing) => {
    const { facts } = await keptWithLanding(landing)
    expect(plan(facts)).toContain('landing kept (existing)')
  })

  it('reads the recorded stack answer, and keeps the landing quiet when the stack cannot be parsed', async () => {
    expect((await factsFor('kept')).landingHidesChecks).toBe(false)
    const dir = scratchCopy('kept')
    const stack = readFileSync(path.join(dir, '.dev', 'stack.yml'), 'utf8')
    const lefthook = recordedParseYaml('kept')
    const facts = await readFacts(dir, {
      gh: recordedGh('kept'),
      gitRemoteUrl: originAcme,
      migrateLabel,
      parseYaml: (text) => {
        if (text === stack) throw new Error('bad stack YAML')
        return lefthook(text)
      },
    })
    expect(facts.landingHidesChecks).toBe(false)
    expect(plan(facts)).toContain('landing kept (existing)')
  })

  it('falls back to the merge-on-green workflow when the landing names no mode', async () => {
    const { facts } = await keptWithLanding({ required_checks: ['widget-build'] })
    expect(facts.landingHidesChecks).toBe(true)
  })
})
