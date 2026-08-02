import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// scan-state.sh feeds Σ for every gate decision in /dev, and had no test until a
// consensus artifact silently resolved as an analysis and wedged the pipeline. /consensus
// itself was removed 2026-08-03; its artifacts remain on disk, so the guard still matters.
// Both hooks below run the SAME functions the live scan runs, dispatched before any
// gh/git use (mirrors ci-watch.sh --classify-merge-state).
const SCAN_STATE = fileURLToPath(new URL('../scan-state.sh', import.meta.url))

let dir: string

function run(...args: string[]): string {
  const r = spawnSync('bash', [SCAN_STATE, ...args], { encoding: 'utf-8' })
  expect(r.status).toBe(0)
  return r.stdout.trim()
}

/** artifact_kind + artifact_status → "<kind>|<status>". */
const classify = (name: string): string => run('--classify-artifact', join(dir, name))

/** resolve_analysis(dir, N, slug) → chosen filename, or '' when nothing qualifies. */
const resolve = (n: string, slug: string): string => run('--resolve-analysis', dir, n, slug)

function write(name: string, frontmatter: Record<string, string>): void {
  const body = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
  writeFileSync(join(dir, name), `---\ntitle: "x"\n${body}\n---\n\n## Problem\n`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'scan-state-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('artifact_kind — frontmatter decides, never the filename', () => {
  it('reads the kind marker each writer emits', () => {
    write('a-analysis.md', { status: 'approved' })
    write('b-consensus.md', { status: 'consensus-reached' })
    write('c-analysis.md', { type: 'brainstorm' })
    expect(classify('a-analysis.md')).toBe('analysis|approved')
    expect(classify('b-consensus.md')).toBe('consensus|consensus-reached')
    // /interview writes brainstorms to {slug}-analysis.md — the name says analysis, the
    // frontmatter says otherwise, and the frontmatter wins.
    expect(classify('c-analysis.md')).toBe('brainstorm|')
  })

  it('treats a missing status key as legacy (empty), not as draft', () => {
    write('legacy-analysis.md', {})
    expect(classify('legacy-analysis.md')).toBe('analysis|')
  })

  it('reports a missing file distinctly from an unclassifiable one', () => {
    expect(classify('nope.md')).toBe('missing|')
  })

  it('classifies regardless of naming convention', () => {
    // Every one of these is a real form in this fleet: bare slug, -iterN, .claude.md,
    // legacy .mdx. A filename filter excluded all but the first.
    for (const name of ['plain.md', 'x-analysis-iter2.mdx', 'x-analysis.claude.md', 'x.mdx']) {
      write(name, { status: 'approved' })
      expect(classify(name)).toBe('analysis|approved')
    }
  })
})

describe('resolve_analysis — the alphabetical-pick regression', () => {
  it('skips a consensus artifact that sorts ahead of the analysis', () => {
    // The exact wedge: `42-auth-consensus.md` < `42-dark-mode-analysis.md`, so a
    // name-only resolver returned the consensus file and Σ.analyze stuck false forever.
    write('42-auth-consensus.md', { status: 'consensus-reached' })
    write('42-dark-mode-analysis.md', { status: 'approved' })
    expect(resolve('42', 'dark-mode')).toBe('42-dark-mode-analysis.md')
  })

  it('skips a brainstorm that sorts ahead of the analysis', () => {
    write('42-aaa-analysis.md', { type: 'brainstorm' })
    write('42-zzz-analysis.md', { status: 'approved' })
    expect(resolve('42', 'zzz')).toBe('42-zzz-analysis.md')
  })

  it('returns nothing when only a consensus artifact exists', () => {
    // Must be empty, not the consensus file: /dev then dispatches /analyze, which is
    // the recovery path. Returning the consensus file is what removed that path.
    write('42-auth-consensus.md', { status: 'consensus-reached' })
    expect(resolve('42', 'auth')).toBe('')
  })

  it('finds an analysis whose name carries no -analysis suffix', () => {
    write('42-auth.md', { status: 'approved' })
    expect(resolve('42', 'auth')).toBe('42-auth.md')
  })

  it('does not let issue #4 match issue #42 (anchored N)', () => {
    write('42-auth-analysis.md', { status: 'approved' })
    expect(resolve('4', '')).toBe('')
  })

  it('falls back to the slug when N does not match', () => {
    write('auth-analysis.md', { status: 'approved' })
    expect(resolve('42', 'auth')).toBe('auth-analysis.md')
  })

  it('returns a draft analysis — status gating is the caller, not the resolver', () => {
    write('42-auth-analysis.md', { status: 'draft' })
    expect(resolve('42', 'auth')).toBe('42-auth-analysis.md')
    expect(classify('42-auth-analysis.md')).toBe('analysis|draft')
  })
})
