import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Gh } from '../../adapters/github/types.ts'
import { catalogueForAction } from '../../dist/contracts.js'
import { actionInputDigest } from '../../engine/action-input.ts'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { multiSisterFixture } from '../../testing/multi-sister-fixture.ts'
import { loadReviewClassCatalogues } from '../review-class-catalogues.ts'

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
