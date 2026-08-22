import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  computeSpawn,
  parsePricedFences,
  pathHit,
} from '../claim-roster.ts'

const SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claim-roster-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeSpec(body: string): string {
  const p = join(dir, 'spec.md')
  writeFileSync(
    p,
    `---
title: test
status: approved
---

## Success Criteria

${body}
`,
  )
  return p
}

describe('parsePricedFences + computeSpawn', () => {
  it('claim on σ forces spawn when path_hit=false', () => {
    const spec = writeSpec(`
- [ ] SC

\`\`\`yaml
claim: [fail-closed]
priced: "x"
not: "y"
oracles: ["z"]
\`\`\`
`)
    const parsed = parsePricedFences(readFileSync(spec, 'utf-8'))
    const out = computeSpawn({
      delta: ['plugins/dev-core/skills/foo.ts'],
      claims: parsed.claims,
      pricedClaimOk: parsed.pricedClaimOk,
      hasPricedFence: parsed.hasPricedFence,
      specDraft: false,
    })
    expect(out.path_hit).toBe(false)
    expect(out.spawn_security_auditor).toBe(true)
  })

  it('invalid claim on priced fence forces spawn (review fail-closed)', () => {
    const spec = writeSpec(`
\`\`\`yaml
priced: "x"
not: "y"
oracles: ["z"]
\`\`\`
`)
    const parsed = parsePricedFences(readFileSync(spec, 'utf-8'))
    expect(parsed.pricedClaimOk).toBe(false)
    const out = computeSpawn({
      delta: ['skills/foo.ts'],
      claims: parsed.claims,
      pricedClaimOk: parsed.pricedClaimOk,
      hasPricedFence: parsed.hasPricedFence,
      specDraft: false,
    })
    expect(out.spawn_security_auditor).toBe(true)
  })

  it('ssot-only claim validates without prose stems', () => {
    const spec = writeSpec(`
\`\`\`yaml
claim: [ssot]
priced: "x"
not: "y"
oracles: ["z"]
\`\`\`
`)
    const parsed = parsePricedFences(readFileSync(spec, 'utf-8'))
    expect(parsed.pricedClaimOk).toBe(true)
    expect(parsed.claims).toContain('ssot')
  })

  it('path_hit when delta touches auth path', () => {
    expect(pathHit(['src/auth/login.ts'])).toBe(true)
    expect(pathHit(['plugins/dev-core/skills/foo.ts'])).toBe(false)
  })
})

describe('SKILL parity — Skip not path-only', () => {
  it('Skip line uses spawn_security_auditor not path-only auth miss', () => {
    const text = readFileSync(SKILL, 'utf-8')
    expect(text).toMatch(/security-auditor → \*\*`¬spawn_security_auditor`\*\*/)
    expect(text).not.toMatch(/security-auditor → Δ misses auth\/secrets\/crypto[^|]*$/)
  })
})
