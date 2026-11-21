import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { catalogueForAction } from '../../dist/contracts.js'
import { actionInputDigest } from '../../engine/action-input.ts'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { loadReviewClassCatalogues } from '../review-class-catalogues.ts'

test('rechecks checkout origin between successive historical catalogue pins', async () => {
  const bytes = readFileSync(new URL('../../skills/dev-review/review-classes.yml', import.meta.url))
  const input = standaloneReviewInputs()
  const pin = input.manifest.plugin.files[0]
  if (pin === undefined) throw new Error('fixture catalogue pin missing')
  const cwd = mkdtempSync(join(tmpdir(), 'catalogue-origin-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  try {
    git('init', '-q')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.test')
    git('remote', 'add', 'origin', `https://github.com/${pin.repository}.git`)
    mkdirSync(dirname(join(cwd, pin.path)), { recursive: true })
    writeFileSync(join(cwd, pin.path), bytes)
    git('add', '--', pin.path)
    git('commit', '-qm', 'fixture')
    const commit = git('rev-parse', 'HEAD')
    const makeAction = (sha: string) => {
      const file = { ...pin, commit: sha }
      const manifest = { ...input.manifest, plugin: { ...input.manifest.plugin, commit: sha, files: [file] } }
      return { ...input, manifest, fingerprint: actionInputDigest(manifest) }
    }
    const absent = makeAction('e'.repeat(40))
    const local = makeAction(commit)
    let deniedReads = 0
    const denied: Gh = async () => {
      deniedReads++
      throw new Error('remote denied')
    }
    const control = await loadReviewClassCatalogues({ histories: [], candidateInputs: [local], cwd, gh: denied })
    expect(catalogueForAction(local, control).ok).toBe(true)
    expect(deniedReads).toBe(0)

    const expressions: string[] = []
    const gh: Gh = async (_cwd, args) => {
      const expression = args.find((arg) => arg.startsWith('expression=')) ?? ''
      expressions.push(expression)
      if (expression === `expression=${'e'.repeat(40)}:${pin.path}`)
        git('remote', 'set-url', 'origin', 'https://github.com/other/repository.git')
      return JSON.stringify({ data: { repository: { object: null } } })
    }
    // This fixture deliberately supplies the absent pin first; assert the observed reads, not an implicit ordering rule.
    const table = await loadReviewClassCatalogues({ histories: [], candidateInputs: [absent, local], cwd, gh })
    expect(expressions).toEqual([`expression=${'e'.repeat(40)}:${pin.path}`, `expression=${commit}:${pin.path}`])
    expect(catalogueForAction(absent, table).ok).toBe(false)
    expect(catalogueForAction(local, table).ok).toBe(false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
