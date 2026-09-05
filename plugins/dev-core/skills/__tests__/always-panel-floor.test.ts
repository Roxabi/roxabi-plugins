import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const skill = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}/SKILL.md`, import.meta.url)), 'utf-8')

const catalog = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}/references/expert-consultation.md`, import.meta.url)), 'utf-8')

function section(text: string, from: string, to: string): string {
  const start = text.indexOf(from)
  const end = text.indexOf(to)
  if (start < 0 || end <= start) {
    throw new Error(`section not found: ${from} .. ${to}`)
  }
  return text.slice(start, end)
}

function alwaysAgents(table: string): string[] {
  return table
    .split('\n')
    .filter((l) => /^\| R-[a-z-]+ \| Always/.test(l))
    .map((l) => l.match(/^\| (R-[a-z-]+)/)?.[1] ?? '')
}

describe('/R-spec auto-panel floor', () => {
  const table = section(skill('spec'), '## Step 4 — Expert Review', '## Step 5')

  it('Always rows are R-adversarial + R-architect; R-doc-writer ¬Always', () => {
    expect(alwaysAgents(table)).toEqual(['R-adversarial', 'R-architect'])
    expect(table).not.toMatch(/^\| R-doc-writer \| Always/m)
  })
})

describe('/R-analyze auto-panel floor', () => {
  const table = section(skill('analyze'), '## Step 3 — Expert Review', '## Step 4')

  it('Always rows are R-product-lead; R-doc-writer ¬Always', () => {
    expect(alwaysAgents(table)).toEqual(['R-product-lead'])
    expect(table).not.toMatch(/^\| R-doc-writer \| Always/m)
  })
})

describe('/R-advisory auto-panel floor', () => {
  const table = section(skill('advisory'), '## Step 1 — Select Advisors', '## Step 2')

  it('Always rows are R-architect + R-product-lead; R-doc-writer ¬Always', () => {
    expect(alwaysAgents(table)).toEqual(['R-architect', 'R-product-lead'])
    expect(table).not.toMatch(/^\| R-doc-writer \| Always/m)
  })

  it('A₃ is xor first-match; no signal → |A|=2; ¬user prompt', () => {
    expect(table).toMatch(/xor/)
    expect(table).toMatch(/first matching/)
    expect(table).toMatch(/\|A\|≤3/)
    expect(table).toMatch(/no signal → \|A\|=2/)
    expect(table).not.toMatch(/Context unclear/)
  })
})

describe('on-demand expert catalogs', () => {
  it('spec and analyze catalogs still list R-doc-writer', () => {
    expect(catalog('spec')).toMatch(/\*\*R-doc-writer\*\*/)
    expect(catalog('analyze')).toMatch(/\*\*R-doc-writer\*\*/)
  })
})
