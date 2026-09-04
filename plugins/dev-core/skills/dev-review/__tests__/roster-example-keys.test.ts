import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DISPATCHABLE, PHASE_AGENTS } from '../roster'

// Example-file roster-key sentinel. The oracle emits `unknown roster agent: X` then
// DROPS the override — an unprefixed key in a shipped example is a silent no-op.
// Copy each file VERBATIM as `.claude/stack.yml` and assert keys ∈ DISPATCHABLE ∪ PHASE_AGENTS
// (¬DISPATCHABLE alone: examples list the 2 PHASE_AGENTS).
//   __tests__ → dev-review → skills → dev-core (stack.yml.example)
//   __tests__ → dev-review → skills → dev-core → plugins → repo-root (.claude/stack.yml.example)
const ROSTER = fileURLToPath(new URL('../roster.ts', import.meta.url))
const PLUGIN_EXAMPLE = fileURLToPath(new URL('../../../stack.yml.example', import.meta.url))
const ROOT_EXAMPLE = fileURLToPath(new URL('../../../../../.claude/stack.yml.example', import.meta.url))

const KNOWN: Record<string, true> = Object.fromEntries([...DISPATCHABLE, ...PHASE_AGENTS].map((a) => [a, true]))

const EXAMPLES: Record<string, string> = {
  'plugins/dev-core/stack.yml.example': PLUGIN_EXAMPLE,
  '.claude/stack.yml.example': ROOT_EXAMPLE,
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-example-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Keys of `review.roster.agents`. Anchored on line-start indent — ¬split on `agents:`
 *  (`max_agents:` is a false hit). */
function rosterAgentKeys(text: string): string[] {
  const keys: string[] = []
  let agentsIndent: number | null = null
  for (const line of text.split('\n')) {
    if (agentsIndent === null) {
      const open = line.match(/^(\s+)agents:\s*(?:#.*)?$/)
      if (open) agentsIndent = open[1].length
      continue
    }
    if (/^\s*(#|$)/.test(line)) continue
    const indent = (line.match(/^(\s*)/) ?? ['', ''])[1].length
    if (indent <= agentsIndent) break
    const colon = line.trim().indexOf(':')
    if (colon < 0) continue
    keys.push(line.trim().slice(0, colon).trim())
  }
  return keys
}

for (const [name, examplePath] of Object.entries(EXAMPLES)) {
  describe(`shipped example roster keys — ${name}`, () => {
    it('A1 no silent drop — verbatim .claude/stack.yml emits no unknown-agent warning', () => {
      mkdirSync(join(dir, '.claude'))
      const stack = join(dir, '.claude', 'stack.yml')
      copyFileSync(examplePath, stack)
      const delta = join(dir, 'delta.txt')
      writeFileSync(delta, 'src/foo.ts\n')
      const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--stack', stack, '--json'], { encoding: 'utf8' })
      expect(proc.status, proc.stderr).toBe(0)
      const json = JSON.parse(proc.stdout) as { warnings: string[] }
      expect(json.warnings.filter((w) => w.includes('unknown roster agent'))).toEqual([])
    })

    it('A2 non-vacuous — review.roster.agents parses to ≥ 1 key', () => {
      expect(rosterAgentKeys(readFileSync(examplePath, 'utf8')).length).toBeGreaterThanOrEqual(1)
    })

    it('A3 referential — every key ∈ DISPATCHABLE ∪ PHASE_AGENTS', () => {
      const keys = rosterAgentKeys(readFileSync(examplePath, 'utf8'))
      expect(keys.filter((k) => !Object.hasOwn(KNOWN, k))).toEqual([])
    })
  })
}
