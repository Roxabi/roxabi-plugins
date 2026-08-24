import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Guards the step-id ≠ skill-name split after collision-safe rename:
// /dev Step column keeps `plan` / `review` / `implement`;
// Skill() invokes `dev-plan` / `dev-review` / `dev-implement`.
const SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url))

describe('/dev step ids vs skill names', () => {
  const text = readFileSync(SKILL, 'utf-8')

  it('keeps pipeline step ids plan, review, and implement', () => {
    expect(text).toMatch(/^\| plan \|/m)
    expect(text).toMatch(/^\| review \|/m)
    expect(text).toMatch(/^\| implement \|/m)
    expect(text).toContain('S* == plan')
    expect(text).toContain('S* == review')
    expect(text).toContain('completed step == plan')
  })

  it('invokes renamed skills, not bare plan/code-review/implement', () => {
    expect(text).toContain('skill: "dev-plan"')
    expect(text).toContain('skill: "dev-review"')
    expect(text).toContain('skill: "dev-implement"')
    expect(text).not.toMatch(/skill:\s*"plan"/)
    expect(text).not.toMatch(/skill:\s*"code-review"/)
    expect(text).not.toMatch(/skill:\s*"implement"/)
  })
})
