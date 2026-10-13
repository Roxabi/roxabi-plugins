import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// scan-state.sh feeds Σ for every gate decision in /R-dev, and had no test until a
// consensus artifact silently resolved as an analysis and wedged the pipeline. /consensus
// itself was removed 2026-08-03; its artifacts remain on disk, so the guard still matters.
// Both hooks below run the SAME functions the live scan runs, dispatched before any
// gh/git use (mirrors ci-watch.sh --classify-merge-state).
const SCAN_STATE = fileURLToPath(new URL('../scan-state.sh', import.meta.url))

let dir: string

function run(...args: string[]): string {
  const r = spawnSync('bash', [SCAN_STATE, ...args], { encoding: 'utf-8' })
  // Surface stderr in the assertion: a shell portability break (macOS sed/awk flags)
  // otherwise fails all 11 with a bare "expected 2 to be +0" and no cause.
  expect(r.status, r.stderr).toBe(0)
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

/** Writes a file verbatim — for shapes `write()` cannot express. */
function writeRaw(name: string, content: string): void {
  writeFileSync(join(dir, name), content)
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
    // /R-interview writes brainstorms to {slug}-analysis.md — the name says analysis, the
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
    // Must be empty, not the consensus file: /R-dev then dispatches /R-analyze, which is
    // the recovery path. Returning the consensus file is what removed that path.
    write('42-auth-consensus.md', { status: 'consensus-reached' })
    expect(resolve('42', 'auth')).toBe('')
  })

  it('returns a draft analysis — status gating is the caller, not the resolver', () => {
    write('42-auth-analysis.md', { status: 'draft' })
    expect(resolve('42', 'auth')).toBe('42-auth-analysis.md')
    expect(classify('42-auth-analysis.md')).toBe('analysis|draft')
  })
})

// These pin name/slug matching, which predates the kind-classification fix and is
// unchanged by it — they stay green if the kind check is removed. Kept deliberately,
// but out of the regression block so its label stays honest.
describe('resolve_analysis — name and slug matching (pre-existing behaviour)', () => {
  it('finds an analysis whose name carries no -analysis suffix', () => {
    write('42-auth.md', { status: 'approved' })
    expect(resolve('42', 'auth')).toBe('42-auth.md')
  })

  it('does not fall through to an empty-slug match when N does not match', () => {
    // `grep -F -- ""` matches every line, so an unguarded slug fallback returned
    // #42's analysis for N=4. The guard is the `[ -n "$slug" ]` in resolve_analysis.
    write('42-auth-analysis.md', { status: 'approved' })
    expect(resolve('4', '')).toBe('')
  })

  it('falls back to the slug when N does not match', () => {
    write('auth-analysis.md', { status: 'approved' })
    expect(resolve('42', 'auth')).toBe('auth-analysis.md')
  })
})

describe('artifact_kind — real-world shapes from this repo', () => {
  it('treats a file with no frontmatter at all as a legacy analysis', () => {
    // release-model-unification-analysis.md and two siblings look like this today.
    // The `analysis` default is what keeps them resolvable — pin it explicitly so a
    // future "unclassified → not an analysis" change has to break a named test.
    writeRaw('legacy.md', '# Analyse\n\nprose, no frontmatter\n')
    expect(classify('legacy.md')).toBe('analysis|')
  })

  it('is not fooled by an HTML comment before the content', () => {
    writeRaw('commented.md', '<!--\nPROVENANCE note\n-->\n\n# Décision\n')
    expect(classify('commented.md')).toBe('analysis|')
  })

  it('reads the fence, not the body — a quoted marker does not decide the kind', () => {
    // The regression this replaced: `head -30` scanned the body, so an analysis
    // documenting the consensus collision classified itself as consensus and became
    // permanently unresolvable.
    writeRaw(
      'quoting.md',
      '---\ntitle: "x"\nstatus: approved\n---\n\n## Problem\n\n```\nstatus: consensus-reached\n```\n',
    )
    expect(classify('quoting.md')).toBe('analysis|approved')
    expect(resolve('', 'quoting')).toBe('quoting.md')
  })

  it('normalizes the YAML spellings that all mean approved', () => {
    writeRaw('quoted.md', '---\nstatus: "Approved"  # was draft\n---\n')
    expect(classify('quoted.md')).toBe('analysis|approved')
  })

  it('ignores merge and backup leftovers', () => {
    write('42-auth-analysis.md.orig', { status: 'approved' })
    expect(classify('42-auth-analysis.md.orig')).toBe('missing|')
    expect(resolve('42', 'auth')).toBe('')
  })

  // Shell integration of the TS classifier (bun dispatch via lib.sh). Detailed
  // fence edge cases live in shared/__tests__/artifact-classify.test.ts — these
  // only prove the scan-state CLI surface still reaches that implementation.
  it('dispatches CRLF and unterminated through the shell hook', () => {
    writeRaw('crlf.md', '---\r\nstatus: draft\r\n---\r\n\nbody\n')
    expect(classify('crlf.md')).toBe('analysis|draft')

    writeRaw('unterminated.md', '---\nstatus: draft\n\n## Body\nstatus: consensus-reached\nstatus: approved\n')
    expect(classify('unterminated.md')).toBe('malformed|')
    expect(resolve('', 'unterminated')).toBe('')
  })

  it('type: analysis beats status: consensus-reached via the shell hook', () => {
    write('typed.md', { type: 'analysis', status: 'consensus-reached' })
    expect(classify('typed.md')).toBe('analysis|consensus-reached')
  })
})
