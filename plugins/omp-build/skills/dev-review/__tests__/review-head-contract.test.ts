import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const SKILL = readFileSync(path.join(import.meta.dirname, '..', 'SKILL.md'), 'utf8')

describe('a bound review is pinned to the snapshot, not a later head', () => {
  it('snapshots headRefOid before gh pr diff and does not git diff the worktree', () => {
    const step = SKILL.split('\n').find((line) => line.startsWith('2. When a PR is bound'))
    expect(step, 'Phase 1 step 2').toBeDefined()
    const text = step ?? ''
    const snapshot = text.indexOf('gh pr view "$PR" --json headRefOid --jq .headRefOid')
    const diff = text.indexOf('gh pr diff "$PR"')
    expect(snapshot).toBeGreaterThan(-1)
    expect(diff).toBeGreaterThan(snapshot)
    expect(text).toContain('Do not `git diff` the worktree.')
  })

  it('refuses to post when the pre-post re-read differs, and does not stamp the new oid', () => {
    const render = SKILL.slice(SKILL.indexOf('### Render once'), SKILL.indexOf('### Post the same body'))
    expect(render).toContain('line 2 is exactly `<!-- omp-build:review-head sha=<40 lowercase hex> -->`')
    expect(render).toContain('naming the Phase 1 `REVIEWED_HEAD` snapshot, never a fresh read')
    expect(render).toContain('Immediately before `gh pr comment`, re-read `headRefOid`.')
    expect(render).toContain('do not post')
    expect(render).toContain('not a head line for the new oid')
  })

  it('keeps the example line 1 as the fix marker and line 2 as the head marker', () => {
    const fence = SKILL.indexOf('```markdown\n<!-- omp-build:code-review -->')
    expect(fence).toBeGreaterThan(-1)
    const body = SKILL.slice(fence + '```markdown\n'.length, SKILL.indexOf('\n```', fence + 1))
    const [line1, line2] = body.split('\n')
    expect(line1).toBe('<!-- omp-build:code-review -->')
    expect(line2).toBe('<!-- omp-build:review-head sha=0123456789abcdef0123456789abcdef01234567 -->')
  })
})
