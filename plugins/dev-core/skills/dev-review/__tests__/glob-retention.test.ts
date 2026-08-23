import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url))

/** Unconditional retention (#419) — listed tokens must stay in When rows until follow-on updates this test. */
const RETAINED_WHEN_TOKENS = ['scripts/', '**/auth/**', 'lefthook.yml']

describe('dev-review SKILL — path glob retention', () => {
  it('security-auditor / architect / devops When rows retain listed triggers', () => {
    const text = readFileSync(SKILL, 'utf-8')
    const whenSection = text.slice(text.indexOf('### Agent dispatch'))
    for (const token of RETAINED_WHEN_TOKENS) {
      expect(whenSection).toContain(token)
    }
    expect(whenSection).not.toContain('classifier_proven')
  })
})
