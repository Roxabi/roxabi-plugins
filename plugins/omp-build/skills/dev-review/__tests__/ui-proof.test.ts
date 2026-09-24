import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const review = readFileSync(fileURLToPath(new URL('../SKILL.md', import.meta.url)), 'utf-8')
const feature = readFileSync(
  fileURLToPath(new URL('../../feature/SKILL.md', import.meta.url)),
  'utf-8',
)

const ENUM = '{infra-not-wired, prompt-logic-only, ui-manual-only, out-of-scope}'

describe('UI proof', () => {
  it('keeps the NO TEST enum and refuses ui-manual-only when an e2e command exists', () => {
    expect(review).toContain(ENUM)
    expect(review).toContain('commands.test_e2e')
    expect(review).toContain('ui-manual-only')
    expect(review).toMatch(/commands\.test_e2e[\s\S]{0,180}ui-manual-only[\s\S]{0,80}issue\(blocking\)/)
    expect(review).toContain('steps, URL, observed result')
  })

  it('tells /feature to check a frontend criterion in the browser', () => {
    const section = feature.slice(feature.indexOf('### 6.2'), feature.indexOf('### 6.3'))
    expect(section).toContain('OMP `browser`')
    expect(section).toContain('commands.test_e2e')
    expect(section).toContain('ui-manual-only')
    expect(section).toContain('steps, URL and observed result')
  })
})
