import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { catalogueForAction } from '../../dist/contracts.js'
import { actionInputDigest } from '../../engine/action-input.ts'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { multiSisterFixture } from '../../testing/multi-sister-fixture.ts'
import { loadReviewClassCatalogues } from '../review-class-catalogues.ts'
import { readGitHubCataloguePins } from '../uw-github-catalogue-pins.ts'

const bytes = readFileSync(new URL('../../skills/dev-review/review-classes.yml', import.meta.url))
const oid = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const input = standaloneReviewInputs()
const pin = input.manifest.plugin.files[0]
if (pin === undefined) throw new Error('fixture catalogue pin missing')

function transport(options: { missing?: boolean; corrupt?: boolean } = {}): Gh {
  return async (_cwd, args) => {
    if (args[1] === 'graphql') {
      const expression = args.find((arg) => arg.startsWith('expression='))?.slice(11)
      const owner = args.find((arg) => arg.startsWith('owner='))?.slice(6)
      const name = args.find((arg) => arg.startsWith('name='))?.slice(5)
      const vector = args.filter((arg) => /^e[0-9]+=/.test(arg))
      if (vector.length) {
        const repository = Object.fromEntries(
          vector.map((field, index) => [
            `f${index}`,
            !options.missing &&
            `${owner}/${name}` === pin.repository &&
            field.slice(field.indexOf('=') + 1) === `${pin.commit}:${pin.path}`
              ? { oid }
              : null,
          ]),
        )
        return JSON.stringify({ data: { repository } })
      }
      const object =
        !options.missing && `${owner}/${name}` === pin.repository && expression === `${pin.commit}:${pin.path}`
          ? { oid }
          : null
      return JSON.stringify({ data: { repository: { object } } })
    }
    if (args.includes(`repos/${pin.repository}/git/blobs/${oid}`)) {
      const content = options.corrupt ? Buffer.from('wrong') : bytes
      return JSON.stringify({ sha: oid, encoding: 'base64', size: content.length, content: content.toString('base64') })
    }
    throw new Error('unexpected request')
  }
}

describe('captured review catalogue loading', () => {
  it('loads and authenticates bytes at the exact captured Git pin', async () => {
    const table = await loadReviewClassCatalogues({
      histories: [],
      candidateInputs: [input],
      cwd: '/not-a-repository',
      gh: transport(),
    })
    expect(catalogueForAction(input, table).ok).toBe(true)
  })

  it('discovers the historical pin from canonical review records without current candidate inputs', async () => {
    const review = multiSisterFixture(1)
    const table = await loadReviewClassCatalogues({
      histories: [review.graph.history],
      cwd: '/not-a-repository',
      gh: transport(),
    })
    expect(catalogueForAction(review.graph.inputs, table).ok).toBe(true)
  })

  it.each([{ missing: true }, { corrupt: true }])('refuses missing or forged blob bytes: %o', async (mode) => {
    const table = await loadReviewClassCatalogues({
      histories: [],
      candidateInputs: [input],
      cwd: '/not-a-repository',
      gh: transport(mode),
    })
    expect(catalogueForAction(input, table).ok).toBe(false)
  })

  it('rejects genuine blob bytes when their digest differs from the captured pin', async () => {
    const changedPin = { ...pin, digest: 'f'.repeat(64) }
    const manifest = { ...input.manifest, plugin: { ...input.manifest.plugin, files: [changedPin] } }
    const changed = { ...input, manifest, fingerprint: actionInputDigest(manifest) }
    const table = await loadReviewClassCatalogues({
      histories: [],
      candidateInputs: [changed],
      cwd: '/not-a-repository',
      gh: transport(),
    })
    expect(catalogueForAction(changed, table).ok).toBe(false)
  })

  it('retains independent historical pins when another captured pin is unavailable', async () => {
    const oldPin = { ...pin, commit: 'e'.repeat(40) }
    const manifest = { ...input.manifest, plugin: { ...input.manifest.plugin, commit: oldPin.commit, files: [oldPin] } }
    const old = { ...input, manifest, fingerprint: actionInputDigest(manifest) }
    const table = await loadReviewClassCatalogues({
      histories: [],
      candidateInputs: [input, old],
      cwd: '/not-a-repository',
      gh: transport(),
    })
    expect(catalogueForAction(input, table).ok).toBe(true)
    expect(catalogueForAction(old, table).ok).toBe(false)
  })

  it('observes each pin again and refuses a revoked blob read in the second round', async () => {
    const otherPin = { ...pin, commit: 'd'.repeat(40) }
    const absentPin = { ...pin, commit: 'e'.repeat(40) }
    const action = (p: typeof pin) => {
      const manifest = { ...input.manifest, plugin: { ...input.manifest.plugin, commit: p.commit, files: [p] } }
      return { ...input, manifest, fingerprint: actionInputDigest(manifest) }
    }
    const other = action(otherPin)
    const absent = action(absentPin)
    let lookups = 0
    let gets = 0
    const gh: Gh = async (_cwd, args) => {
      if (args[1] === 'graphql') {
        lookups++
        const fields = args.filter((arg) => /^e[0-9]+=/.test(arg))
        const repository = Object.fromEntries(
          fields.map((field, index) => [`f${index}`, field.includes(absentPin.commit) ? null : { oid }]),
        )
        return JSON.stringify({ data: { repository } })
      }
      gets++
      if (gets === 2) throw new Error('permission revoked')
      return JSON.stringify({ sha: oid, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') })
    }
    const load = () =>
      loadReviewClassCatalogues({
        histories: [],
        candidateInputs: [input, other, absent],
        cwd: '/not-a-repository',
        gh,
      })
    const first = await load()
    expect(catalogueForAction(input, first).ok).toBe(true)
    expect(catalogueForAction(other, first).ok).toBe(true)
    expect(catalogueForAction(absent, first).ok).toBe(false)
    const second = await load()
    expect(catalogueForAction(input, second).ok).toBe(false)
    expect(catalogueForAction(other, second).ok).toBe(false)
    expect(catalogueForAction(absent, second).ok).toBe(false)
    expect([lookups, gets]).toEqual([2, 2])
  })

  it('refuses a mixed repository, checkout or transport before querying for catalogue pins', async () => {
    let reads = 0
    const gh: Gh = async () => {
      reads++
      throw new Error('Unexpected transport read')
    }
    const base = { repository: pin.repository, commit: pin.commit, path: pin.path, cwd: '/fixture', gh }
    for (const other of [
      { ...base, gh: transport() },
      { ...base, cwd: '/elsewhere' },
      { ...base, repository: 'a/b' },
    ]) {
      const results = await readGitHubCataloguePins([base, other])
      expect(results.map((result) => result.ok)).toEqual([false, false])
    }
    expect(reads).toBe(0)
  })

  it('attributes one failed shared blob fetch to each distinct pin', async () => {
    let gets = 0
    const gh: Gh = async (_cwd, args) => {
      if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { f0: { oid }, f1: { oid } } } })
      gets++
      throw new Error('blob denied')
    }
    const first = { repository: pin.repository, commit: 'a'.repeat(40), path: pin.path, cwd: '/fixture', gh }
    const second = { ...first, commit: 'b'.repeat(40) }
    const results = await readGitHubCataloguePins([first, second])
    expect(gets).toBe(1)
    for (const [index, result] of results.entries()) {
      if (result.ok) throw new Error('expected denied blob')
      expect(result.diagnostics[0].message).toContain(index === 0 ? first.commit : second.commit)
      expect(result.diagnostics[0].message).not.toContain(index === 0 ? second.commit : first.commit)
    }
  })

  it('accepts only uniquely alias-attributed partial errors, including nonzero gh exits', async () => {
    const otherPin = { ...pin, commit: 'd'.repeat(40) }
    const manifest = {
      ...input.manifest,
      plugin: { ...input.manifest.plugin, commit: otherPin.commit, files: [otherPin] },
    }
    const other = { ...input, manifest, fingerprint: actionInputDigest(manifest) }
    for (const path of [['repository', 'f1'], ['repository'], ['repository', 'f9']]) {
      const gh: Gh = async (_cwd, args) => {
        if (args[1] === 'graphql') {
          const stdout = JSON.stringify({ data: { repository: { f0: { oid }, f1: null } }, errors: [{ path }] })
          throw Object.assign(new Error('GraphQL error'), { stdout })
        }
        return JSON.stringify({ sha: oid, encoding: 'base64', size: bytes.length, content: bytes.toString('base64') })
      }
      const table = await loadReviewClassCatalogues({
        histories: [],
        candidateInputs: [input, other],
        cwd: '/not-a-repository',
        gh,
      })
      expect(catalogueForAction(input, table).ok).toBe(path.length === 2 && path[1] === 'f1')
      expect(catalogueForAction(other, table).ok).toBe(false)
    }
  })

  it('does not choose between conflicting digests for the same coordinates', async () => {
    const plugin = input.manifest.plugin
    const otherPin = { ...pin, digest: 'f'.repeat(64) }
    const manifest = { ...input.manifest, plugin: { ...plugin, files: [otherPin] } }
    const other = { ...input, manifest, fingerprint: actionInputDigest(manifest) }
    const table = await loadReviewClassCatalogues({
      histories: [],
      candidateInputs: [input, other],
      cwd: '/not-a-repository',
      gh: transport(),
    })
    expect(catalogueForAction(input, table).ok).toBe(false)
    expect(catalogueForAction(other, table).ok).toBe(false)
  })
})
