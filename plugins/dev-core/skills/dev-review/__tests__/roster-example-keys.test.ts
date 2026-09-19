import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DISPATCHABLE } from '../roster'

// Example-file roster-key sentinel. The shipped template must advertise only active
// dispatchable roles; legacy keys are parser compatibility, not target config.
// Repos carry `.dev/stack.yml` (their real contract) and no `.example` copy, so the
// plugin template is the only example there is to pin.
//   __tests__ → dev-review → skills → dev-core (stack.yml.example)
const ROSTER = fileURLToPath(new URL('../roster.ts', import.meta.url))
const PLUGIN_EXAMPLE = fileURLToPath(new URL('../../../stack.yml.example', import.meta.url))

const KNOWN: Record<string, true> = Object.fromEntries(DISPATCHABLE.map((a) => [a, true]))

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

describe('shipped example roster keys — plugins/dev-core/stack.yml.example', () => {
  it('A1 no silent drop — verbatim .dev/stack.yml emits no unknown-agent warning', () => {
    mkdirSync(join(dir, '.dev'))
    const stack = join(dir, '.dev', 'stack.yml')
    copyFileSync(PLUGIN_EXAMPLE, stack)
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/foo.ts\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--stack', stack, '--json'], { encoding: 'utf8' })
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { warnings: string[] }
    expect(json.warnings.filter((w) => w.includes('unknown roster agent'))).toEqual([])
  })

  it('A2 non-vacuous — review.roster.agents parses to ≥ 1 key', () => {
    expect(rosterAgentKeys(readFileSync(PLUGIN_EXAMPLE, 'utf8')).length).toBeGreaterThanOrEqual(1)
  })

  it('A3 referential — every advertised key is dispatchable', () => {
    const keys = rosterAgentKeys(readFileSync(PLUGIN_EXAMPLE, 'utf8'))
    expect(keys.filter((k) => !Object.hasOwn(KNOWN, k))).toEqual([])
  })
})
