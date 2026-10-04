import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const skill = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../SKILL.md'), 'utf8')

function recipe(): string {
  const start = skill.indexOf('## Complexity Scoring')
  const end = skill.indexOf('## Example Workflow')
  return skill.slice(start, end)
}

describe('complexity scoring recipe', () => {
  it('refuses a failed or empty read and writes the same repo', () => {
    const block = recipe()
    expect(block).toContain('set -euo pipefail')
    expect(block).toContain('gh issue view "$N" --repo "$REPO"')
    expect(block).toMatch(/GITHUB_REPO="\$REPO" T set "\$\{REPO\}#\$\{N\}" --body-file/)
    expect(block).toContain('<!-- complexity:')
    expect(block).toMatch(/sed/)
    expect(block).not.toContain('gh issue edit')
    expect(block).not.toContain('--repo ""')
    expect(block).toContain('[ -z "$REPO" ]')
    expect(block).toContain('[ -z "$trimmed" ]')
  })
})
