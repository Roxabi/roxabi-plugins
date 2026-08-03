import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  artifactKind,
  artifactStatus,
  classifyFromContent,
  extractFrontmatter,
  frontmatterKey,
  resolveAnalysis,
} from '../artifact-classify'

let dir: string

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content)
}

function fm(fields: Record<string, string>, body = '## Problem\n'): string {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`)
  return `---\ntitle: "x"\n${lines.join('\n')}\n---\n\n${body}`
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'artifact-classify-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('extractFrontmatter — fence contract', () => {
  it('accepts CRLF fences (regression: ---\\r was "no frontmatter" → false approved)', () => {
    const raw = '---\r\ntitle: x\r\nstatus: draft\r\n---\r\n\nbody\n'
    const fence = extractFrontmatter(raw)
    expect(fence.state).toBe('ok')
    if (fence.state === 'ok') {
      expect(frontmatterKey(fence.body, 'status')).toBe('draft')
    }
    expect(classifyFromContent(raw)).toEqual({ kind: 'analysis', status: 'draft' })
  })

  it('accepts trailing space on fence lines', () => {
    const raw = '--- \ntitle: x\nstatus: draft\n--- \n\nbody\n'
    expect(classifyFromContent(raw)).toEqual({ kind: 'analysis', status: 'draft' })
  })

  it('strips UTF-8 BOM before the opening fence', () => {
    const raw = '\uFEFF---\ntitle: x\nstatus: draft\n---\n\nbody\n'
    expect(classifyFromContent(raw)).toEqual({ kind: 'analysis', status: 'draft' })
  })

  it('fail-closes on unterminated fence — body is never header', () => {
    // Bash awk printed the whole file; status: consensus-reached in the body
    // became the kind, and an injected approved could gate the pipeline.
    const raw = '---\ntitle: x\nstatus: draft\n\n## Body\nstatus: consensus-reached\nstatus: approved\n'
    const fence = extractFrontmatter(raw)
    expect(fence.state).toBe('unterminated')
    expect(classifyFromContent(raw)).toEqual({ kind: 'malformed', status: '' })
  })

  it('treats a missing opening fence as legacy analysis (empty status)', () => {
    expect(classifyFromContent('# Analyse\n\nprose, no frontmatter\n')).toEqual({
      kind: 'analysis',
      status: '',
    })
  })
})

describe('frontmatter keys — YAML last-wins', () => {
  it('last status wins (not head -1 first-wins)', () => {
    const raw = '---\nstatus: approved\nstatus: draft\n---\n\nbody\n'
    expect(classifyFromContent(raw)).toEqual({ kind: 'analysis', status: 'draft' })
  })

  it('normalizes quotes, comments, and case', () => {
    const raw = '---\nstatus: "Approved"  # was draft\n---\n'
    expect(classifyFromContent(raw)).toEqual({ kind: 'analysis', status: 'approved' })
  })
})

describe('kind classification', () => {
  it('reads the kind marker each writer emits', () => {
    expect(classifyFromContent(fm({ status: 'approved' }))).toEqual({
      kind: 'analysis',
      status: 'approved',
    })
    expect(classifyFromContent(fm({ status: 'consensus-reached' }))).toEqual({
      kind: 'consensus',
      status: 'consensus-reached',
    })
    expect(classifyFromContent(fm({ type: 'brainstorm' }))).toEqual({
      kind: 'brainstorm',
      status: '',
    })
  })

  it('type: analysis is required to beat status: consensus-reached (falsifies dropping the branch)', () => {
    // Without an explicit type:analysis arm, status:consensus-reached would win
    // and a legitimate analysis that recorded that token as status would vanish.
    expect(classifyFromContent(fm({ type: 'analysis', status: 'consensus-reached' }))).toEqual({
      kind: 'analysis',
      status: 'consensus-reached',
    })
  })

  it('type: brainstorm wins over a misleading -analysis.md name and approved status', () => {
    expect(classifyFromContent(fm({ type: 'brainstorm', status: 'approved' }))).toEqual({
      kind: 'brainstorm',
      status: 'approved',
    })
  })

  it('is not fooled by a quoted marker in the body', () => {
    const raw = '---\ntitle: "x"\nstatus: approved\n---\n\n## Problem\n\n```\nstatus: consensus-reached\n```\n'
    expect(classifyFromContent(raw)).toEqual({ kind: 'analysis', status: 'approved' })
  })
})

describe('classifyFile / resolveAnalysis', () => {
  it('reports missing and backup leftovers', () => {
    expect(artifactKind(join(dir, 'nope.md'))).toBe('missing')
    write('x.md.orig', fm({ status: 'approved' }))
    expect(artifactKind(join(dir, 'x.md.orig'))).toBe('missing')
  })

  it('skips consensus that sorts ahead of the analysis', () => {
    write('42-auth-consensus.md', fm({ status: 'consensus-reached' }))
    write('42-dark-mode-analysis.md', fm({ status: 'approved' }))
    expect(resolveAnalysis(dir, '42', 'dark-mode')).toBe('42-dark-mode-analysis.md')
  })

  it('skips brainstorm that sorts ahead of the analysis', () => {
    write('42-aaa-analysis.md', fm({ type: 'brainstorm' }))
    write('42-zzz-analysis.md', fm({ status: 'approved' }))
    expect(resolveAnalysis(dir, '42', 'zzz')).toBe('42-zzz-analysis.md')
  })

  it('returns nothing when only consensus exists (recovery path)', () => {
    write('42-auth-consensus.md', fm({ status: 'consensus-reached' }))
    expect(resolveAnalysis(dir, '42', 'auth')).toBe('')
  })

  it('returns a draft analysis — status gating is the caller', () => {
    write('42-auth-analysis.md', fm({ status: 'draft' }))
    expect(resolveAnalysis(dir, '42', 'auth')).toBe('42-auth-analysis.md')
    expect(artifactStatus(join(dir, '42-auth-analysis.md'))).toBe('draft')
  })

  it('skips malformed (unterminated) candidates', () => {
    write('42-auth-analysis.md', '---\ntitle: x\nstatus: draft\n\n## body\nstatus: approved\n')
    expect(artifactKind(join(dir, '42-auth-analysis.md'))).toBe('malformed')
    expect(resolveAnalysis(dir, '42', 'auth')).toBe('')
  })

  it('does not fall through empty-slug when N does not match', () => {
    write('42-auth-analysis.md', fm({ status: 'approved' }))
    expect(resolveAnalysis(dir, '4', '')).toBe('')
  })

  it('falls back to slug when N does not match', () => {
    write('auth-analysis.md', fm({ status: 'approved' }))
    expect(resolveAnalysis(dir, '42', 'auth')).toBe('auth-analysis.md')
  })
})
