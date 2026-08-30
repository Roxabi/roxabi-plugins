import { describe, expect, it } from 'vitest'
import { rewriteHarnessPaths } from '../paths'

describe('rewriteHarnessPaths', () => {
  it('expands leftover CLAUDE_SKILL_DIR and CLAUDE_PLUGIN_ROOT for dump fallback', () => {
    const out = rewriteHarnessPaths(
      'bun "${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts" list',
      '/plug/skills/issue-triage',
      '/plug',
    )
    expect(out).toBe('bun "/plug/skills/issue-triage/triage.ts" list')
  })

  it('expands unbraced $CLAUDE_SKILL_DIR', () => {
    const out = rewriteHarnessPaths('bun "$CLAUDE_SKILL_DIR/triage.ts"', '/plug/skills/issue-triage', '/plug')
    expect(out).toBe('bun "/plug/skills/issue-triage/triage.ts"')
  })
})
