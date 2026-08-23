import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const DEV_SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const SHIP_SKILL = fileURLToPath(new URL('../../ship/SKILL.md', import.meta.url))
const SCAN_STATE = fileURLToPath(new URL('../scan-state.sh', import.meta.url))

/** First-column cells of the invocation map (`| Step | Class | Skill …`). */
function parseStepColumn(markdown: string): string[] {
  const lines = markdown.split('\n')
  const header = lines.findIndex((l) => /^\| Step \| Class \|/u.test(l))
  expect(header, 'invocation map header').toBeGreaterThan(-1)
  const steps: string[] = []
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break
    const cell = line.split('|')[1]?.trim() ?? ''
    if (cell.length > 0) steps.push(cell)
  }
  return steps
}

function scanStateKeys(script: string): Set<string> {
  const keys = new Set<string>()
  for (const match of script.matchAll(/echo "(?<key>[a-z_]+)=/gu)) {
    if (match.groups?.key) keys.add(match.groups.key)
  }
  return keys
}

describe('orchestrator step ids vs skill/slash ids', () => {
  const devSteps = parseStepColumn(readFileSync(DEV_SKILL, 'utf8'))
  const shipSteps = parseStepColumn(readFileSync(SHIP_SKILL, 'utf8'))
  const diskKeys = scanStateKeys(readFileSync(SCAN_STATE, 'utf8'))

  it('no invocation-map Step cell uses a dev-* skill/slash id', () => {
    const leaked = [...devSteps, ...shipSteps].filter((s) => s.startsWith('dev-'))
    expect(leaked, 'step ids must not be skill/slash names').toEqual([])
  })

  it('disk-backed /dev steps are keys emitted by scan-state.sh', () => {
    const diskBacked = ['frame', 'analyze', 'spec', 'plan', 'implement', 'pr']
    expect(devSteps).toEqual(expect.arrayContaining(diskBacked))
    for (const step of diskBacked) {
      expect(diskKeys.has(step), `scan-state.sh emits ${step}=`).toBe(true)
    }
  })
})
