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
import { toolingGh } from '../../testing/review-gate-tooling-gh.ts'
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

it('authenticates the remote commit before fetching a reachable catalogue blob', async () => {
  const remote = mkdtempSync(join(tmpdir(), 'omp-remote-catalogue-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['--no-replace-objects', ...args], { cwd: remote, encoding: 'utf8' }).trim()
  const initial = standaloneReviewInputs()
  const original = initial.manifest.plugin.files[0]
  if (original === undefined) throw new Error('fixture catalogue pin missing')
  const bytes = '- class: historical\n'
  try {
    git('init', '-q')
    git('remote', 'add', 'origin', 'https://github.com/acme/unrelated.git')
    const file = join(remote, original.path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, bytes)
    git('add', '--', original.path)
    git('-c', 'user.name=Historical Catalogue', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Catalogue')
    const commit = git('rev-parse', 'HEAD')
    const tree = git('rev-parse', 'HEAD^{tree}')
    expect(git('cat-file', 'blob', `${tree}:${original.path}`)).toBe(bytes.trim())

    const requests: string[][] = []
    const gh: Gh = async (_cwd, args) => {
      requests.push(args)
      const response = toolingGh(args, remote)
      if (response === undefined) throw new Error('unexpected remote catalogue request')
      return response
    }
    const read = async (sha: string, transport = gh) => {
      const pin = { ...original, commit: sha, digest: createHash('sha256').update(bytes).digest('hex') }
      const manifest = { ...initial.manifest, plugin: { ...initial.manifest.plugin, commit: sha, files: [pin] } }
      const candidate = { ...initial, manifest, fingerprint: actionInputDigest(manifest) }
      const catalogues = await loadReviewClassCatalogues({
        histories: [],
        candidateInputs: [candidate],
        cwd: remote,
        gh: transport,
      })
      return catalogueForAction(candidate, catalogues)
    }
    expect((await read(tree)).ok).toBe(false)
    expect(requests).toEqual([
      expect.arrayContaining(['graphql', `commit=${tree}`, `expression=${tree}:${original.path}`]),
    ])
    expect(await read(commit)).toEqual({ ok: true, value: ['historical'] })
    expect(requests.slice(1)).toEqual([
      expect.arrayContaining(['graphql', `commit=${commit}`, `expression=${commit}:${original.path}`]),
      expect.arrayContaining([
        `repos/${original.repository}/git/blobs/${git('rev-parse', `${commit}:${original.path}`)}`,
      ]),
    ])

    requests.length = 0
    const wrongCommit: Gh = async (_cwd, args) => {
      requests.push(args)
      return JSON.stringify({
        data: {
          repository: {
            commit: { __typename: 'Commit', oid: 'f'.repeat(40) },
            object: { oid: git('rev-parse', `${commit}:${original.path}`) },
          },
        },
      })
    }
    expect((await read(commit, wrongCommit)).ok).toBe(false)
    expect(requests).toEqual([
      expect.arrayContaining(['graphql', `commit=${commit}`, `expression=${commit}:${original.path}`]),
    ])
  } finally {
    rmSync(remote, { recursive: true, force: true })
  }
})
