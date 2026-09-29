import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * External programs (bun, bash, …) do not resolve `skill://`. A body that hands
 * that URL as argv fails in the OMP shell (#619). Builtins (`read`/`cat`) may
 * still take `skill://` — this regex only matches an external program.
 *
 * Corpus: every SKILL.md under plugins/, plus agents/*.md and references/*.md.
 */
const REPO = path.resolve(import.meta.dirname, '../../../..')
const PLUGINS = path.join(REPO, 'plugins')

/** `\b(bun|bash|node|sh|bunx|npx)\b(\s+(run|-\S+))*\s+"?skill://` */
const EXTERNAL_SKILL_ARGV =
  /\b(?:bun|bash|node|sh|bunx|npx)\b(?:\s+(?:run|-\S+))*\s+"?skill:\/\//

/**
 * #627 rewrites cleanup's bash skill:// sites to the realpath form. Until that
 * PR lands on main, allow-list only this file; remove the entry once merged.
 */
const ALLOWED = new Set(['plugins/omp-build/skills/cleanup/SKILL.md'])

function walk(dir: string, match: (rel: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue
      out.push(...walk(abs, match))
      continue
    }
    const rel = path.relative(REPO, abs).split(path.sep).join('/')
    if (match(rel)) out.push(rel)
  }
  return out
}

function isCorpus(rel: string): boolean {
  if (rel.endsWith('/SKILL.md') || rel === 'SKILL.md') return true
  const parts = rel.split('/')
  const parent = parts.at(-2)
  return (parent === 'agents' || parent === 'references') && rel.endsWith('.md')
}

describe('external programs never take bare skill:// argv', () => {
  const corpus = walk(PLUGINS, isCorpus)

  it('scans a non-empty corpus of skill, agent, and reference bodies', () => {
    expect(corpus.some((f) => f.endsWith('/SKILL.md'))).toBe(true)
    expect(corpus.some((f) => f.includes('/agents/') && f.endsWith('.md'))).toBe(true)
    expect(corpus.some((f) => f.includes('/references/') && f.endsWith('.md'))).toBe(true)
    expect(corpus.length).toBeGreaterThan(40)
  })

  it('finds no external-argv skill:// outside the temporary #627 allow-list', () => {
    const hits: string[] = []
    for (const rel of corpus) {
      if (ALLOWED.has(rel)) continue
      const text = readFileSync(path.join(REPO, rel), 'utf8')
      for (const [i, line] of text.split('\n').entries()) {
        if (EXTERNAL_SKILL_ARGV.test(line)) hits.push(`${rel}:${i + 1}:${line.trim()}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('keep the allow-list honest: every entry still matches today', () => {
    // An entry whose body is already clean would hide a future regression in a
    // different file by bloating ALLOWED. Drop entries as #627 lands.
    for (const rel of ALLOWED) {
      const text = readFileSync(path.join(REPO, rel), 'utf8')
      expect(EXTERNAL_SKILL_ARGV.test(text), rel).toBe(true)
    }
  })
})
