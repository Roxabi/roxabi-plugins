import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { actionInputDigest } from '../../engine/action-input.ts'
import { catalogueForAction } from '../../engine/review-class-catalogue.ts'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { loadReviewClassCatalogues } from '../review-class-catalogues.ts'

it('uses the exact historical catalogue blob, never current or wrong-repository bytes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'omp-historical-catalogue-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const initial = standaloneReviewInputs()
  const original = initial.manifest.plugin.files[0]
  if (original === undefined) throw new Error('fixture catalogue pin missing')
  const originalBytes = '- class: historical\n'
  const changedBytes = '- class: different\n'
  try {
    git('init', '-q')
    git('config', 'user.name', 'Historical Catalogue')
    git('config', 'user.email', 'fixture@example.test')
    git('remote', 'add', 'origin', `https://github.com/${original.repository}.git`)
    const path = join(cwd, original.path)
    mkdirSync(dirname(path), { recursive: true })
    const commit = (bytes: string, message: string) => {
      writeFileSync(path, bytes)
      git('add', '--', original.path)
      git('commit', '-qm', message)
      return git('rev-parse', 'HEAD')
    }
    const historic = commit(originalBytes, 'original catalogue')
    const changed = commit(changedBytes, 'new catalogue')
    const input = (sha: string) => {
      const pin = { ...original, commit: sha, digest: createHash('sha256').update(originalBytes).digest('hex') }
      const manifest = { ...initial.manifest, plugin: { ...initial.manifest.plugin, commit: sha, files: [pin] } }
      return { ...initial, manifest, fingerprint: actionInputDigest(manifest) }
    }
    const requests: string[][] = []
    const gh: Gh = async (_cwd, args) => {
      requests.push(args)
      throw new Error('Pinned catalogue is not available from GitHub')
    }
    const read = async (sha: string) => {
      const candidate = input(sha)
      const catalogues = await loadReviewClassCatalogues({ histories: [], candidateInputs: [candidate], cwd, gh })
      return catalogueForAction(candidate, catalogues)
    }
    expect(await read(historic)).toEqual({ ok: true, value: ['historical'] })
    expect(await read(changed)).toMatchObject({ ok: false, diagnostics: [{ code: 'unreadable' }] })
    expect(requests).toEqual([])
    git('remote', 'set-url', 'origin', 'https://github.com/acme/unrelated.git')
    expect((await read(historic)).ok).toBe(false)
    expect(requests).toEqual([expect.arrayContaining([`expression=${historic}:${original.path}`])])
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
