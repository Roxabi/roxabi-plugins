import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const text = readFileSync(fileURLToPath(new URL('./SKILL.md', import.meta.url)), 'utf-8')
const frame = text.slice(text.indexOf('## 4. Frame'), text.indexOf('## 5. Frontier'))
const plan = text.slice(text.indexOf('### 6.1'), text.indexOf('### 6.2'))

describe('plan review', () => {
  it('writes a decision brief except for size:S', () => {
    expect(frame).toContain('decision brief')
    expect(frame).toContain('what, why, chosen solution, pros, cons, and rejected alternatives')
    expect(frame).toContain('Skip the brief for `size:S`')
    expect(frame).toMatch(/before[\s\S]{0,40}publishing/)
  })

  it('reviews the plan once, outside the review loop', () => {
    expect(plan).toContain('R-architect')
    expect(plan).toContain('R-adversarial')
    expect(plan).toContain('read-only')
    expect(plan).toContain('one round')
    expect(plan).toContain('never calls the review loop')
    expect(plan).toContain('spends no fix round')
    expect(plan).toContain('writes no PR marker')
    expect(plan).toContain('before any code')
  })
})
