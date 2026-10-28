import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeSimCommand } from './sim-execution.ts'
import { base, dispose, openState, pull, run, saved } from './sim-transport-fixture.ts'
import { GITHUB_COMMENT_LIMIT } from './sim-types.ts'

describe('simulator transport protocol', () => {
  it('stores a stdin comment with its exact newlines and rejects an overlong body without publishing', () => {
    const box = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40)) } }))
    try {
      const stored = run(box.file, ['pr', 'comment', '10', '--body-file', '-'], box.root, 'in\n\nout\n')
      expect(stored.status).toBe(0)
      expect(saved(box.file).prs['10'].comments[0].body).toBe('in\n\nout\n')
      const before = saved(box.file).prs['10'].comments
      const rejected = run(
        box.file,
        ['pr', 'comment', '10', '--body-file', '-'],
        box.root,
        'x'.repeat(GITHUB_COMMENT_LIMIT + 1),
      )
      expect(rejected.status).toBe(1)
      expect(rejected.stderr).toContain('Body is too long')
      expect(saved(box.file).prs['10'].comments).toEqual(before)
    } finally {
      dispose(box.root)
    }
  })

  it('reads a named body file from the invocation cwd', () => {
    const box = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40)) } }))
    const ambient = join(box.root, 'ambient')
    mkdirSync(ambient)
    writeFileSync(join(ambient, 'note.txt'), 'decoy\n')
    writeFileSync(join(box.root, 'note.txt'), 'keep\n\nthis\n')
    try {
      const result = run(box.file, ['pr', 'comment', '10', '--body-file', 'note.txt'], box.root)
      expect(result.status).toBe(0)
      const published = saved(box.file).prs['10'].comments.at(-1)
      expect(published).toBeDefined()
      if (published === undefined) throw new Error('named body file was not published')
      expect(published.body).toBe('keep\n\nthis\n')
    } finally {
      dispose(box.root)
    }
  })

  it('refuses a literal dot-segment body path and rolls the label back', () => {
    const box = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40)) } }))
    writeFileSync(join(box.root, 'note.md'), 'must not publish\n')
    try {
      const result = run(
        box.file,
        ['pr', 'edit', '10', '--add-label', 'reviewed', '--body-file', 'note.md/../note.md'],
        box.root,
      )
      const pr = saved(box.file).prs['10']
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('ENOTDIR')
      expect(result.stderr).toContain('note.md/../note.md')
      expect(pr.body).toBe('original\n')
      expect(pr.labels).toEqual([])
      expect(saved(box.file).calls).toEqual([])
    } finally {
      dispose(box.root)
    }
  })

  it('publishes the filesystem-resolved symlink body, not the lexical decoy', () => {
    const box = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40)) } }))
    const nested = join(box.root, 'outside', 'nested')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(box.root, 'outside', 'note.md'), 'resolved-via-hop\n')
    writeFileSync(join(box.root, 'note.md'), 'lexical-decoy\n')
    symlinkSync(nested, join(box.root, 'hop'))
    try {
      const result = run(box.file, ['pr', 'edit', '10', '--body-file', 'hop/../note.md'], box.root)
      expect(result.status).toBe(0)
      expect(saved(box.file).prs['10'].body).toBe('resolved-via-hop\n')
    } finally {
      dispose(box.root)
    }
  })

  it('keeps an unknown command and a failing jq filter from mutating state', () => {
    const box = openState(base())
    try {
      const unknown = run(box.file, ['pr', 'diff', '1'], box.root)
      expect(unknown.status).toBe(1)
      expect(unknown.stderr).toContain('pr diff 1')
      expect(saved(box.file).calls).toEqual([])
      const jq = run(box.file, ['repo', 'view', '--jq', 'not_a_filter'], box.root)
      expect(jq.status).toBe(1)
      expect(jq.stderr.length).toBeGreaterThan(0)
      expect(saved(box.file)).toMatchObject({ owner: 'acme', name: 'app', calls: [] })
    } finally {
      dispose(box.root)
    }
  })

  it('retains jq stderr when the filter succeeds', () => {
    const box = openState(base())
    try {
      const result = run(box.file, ['repo', 'view', '--jq', 'debug'], box.root)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('acme/app')
      expect(result.stderr).toContain('DEBUG')
    } finally {
      dispose(box.root)
    }
  })

  it('keeps the edited body unpublished when the state rename target is a directory', () => {
    const box = openState(base({ prs: { 10: pull(10, 'feat/a', 'b'.repeat(40)) } }))
    mkdirSync(`${box.file}.tmp`)
    try {
      const result = run(box.file, ['pr', 'edit', '10', '--body', 'ok'], box.root)
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('https://example.test/acme/app/pull/10')
      expect(saved(box.file).prs['10'].body).toBe('original\n')
    } finally {
      dispose(box.root)
    }
  })

  it('does not read stdin when the comment route fails before the body', () => {
    const box = openState(base())
    const previous = process.env.GH_SIM_STATE
    process.env.GH_SIM_STATE = box.file
    let reads = 0
    try {
      const result = executeSimCommand(['pr', 'comment', '999', '--body-file', '-'], {
        cwd: box.root,
        readStdin() {
          reads += 1
          return 'unused\n'
        },
      })
      expect(result.status).toBe(1)
      expect(reads).toBe(0)
      expect(saved(box.file).calls).toEqual([])
    } finally {
      if (previous === undefined) delete process.env.GH_SIM_STATE
      else process.env.GH_SIM_STATE = previous
      dispose(box.root)
    }
  })
})
