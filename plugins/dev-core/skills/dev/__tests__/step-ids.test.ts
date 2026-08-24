import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Guards the step-id ≠ skill-name split after collision-safe rename:
// /dev Step column keeps `plan` / `review`; Skill() invokes `dev-plan` / `dev-review`.
const SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url))

describe('/dev step ids vs skill names', () => {
  const text = readFileSync(SKILL, 'utf-8')

  it('keeps pipeline step ids plan and review', () => {
    expect(text).toMatch(/^\| plan \|/m)
    expect(text).toMatch(/^\| review \|/m)
    expect(text).toContain('S* == plan')
    expect(text).toContain('S* == review')
    expect(text).toContain('completed step == plan')
  })

  it('invokes renamed skills, not bare plan/code-review', () => {
    expect(text).toContain('skill: "dev-plan"')
    expect(text).toContain('skill: "dev-review"')
    expect(text).not.toMatch(/skill:\s*"plan"/)
    expect(text).not.toMatch(/skill:\s*"code-review"/)
  })
})
