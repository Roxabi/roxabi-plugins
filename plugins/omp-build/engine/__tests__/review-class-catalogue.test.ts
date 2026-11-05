import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { actionInputDigest } from '../action-input.ts'
import {
  catalogueForAction,
  createReviewClassCatalogues,
  parseReviewClassCatalogue,
  reviewClassCatalogueRef,
} from '../review-class-catalogue.ts'

const bytes = new TextEncoder().encode('classes:\n  - class: test-tautology\n')
const digest = createHash('sha256').update(bytes).digest('hex')

function action(commit = 'b'.repeat(40), fileDigest = digest) {
  const base = standaloneReviewInputs()
  const plugin = base.manifest.plugin
  const ref = {
    source: 'git-file' as const,
    repository: plugin.repository,
    commit,
    path: `${plugin.root}/skills/dev-review/review-classes.yml`,
    digest: fileDigest,
  }
  const manifest = { ...base.manifest, plugin: { ...plugin, commit, files: [ref] } }
  return { inputs: { ...base, manifest, fingerprint: actionInputDigest(manifest) }, ref }
}

it('accepts only verified bytes for the exact action pin, across distinct historical commits', () => {
  const first = action()
  const second = action('c'.repeat(40))
  const table = createReviewClassCatalogues([{ ref: first.ref, contents: { ok: true, value: bytes } }])
  expect(catalogueForAction(first.inputs, table)).toEqual({ ok: true, value: ['test-tautology'] })
  expect(catalogueForAction(second.inputs, table).ok).toBe(false)
  const both = createReviewClassCatalogues(
    [first, second].map(({ ref }) => ({ ref, contents: { ok: true as const, value: bytes } })),
  )
  expect(catalogueForAction(second.inputs, both)).toEqual({ ok: true, value: ['test-tautology'] })
})

it('uses each historical action’s own catalogue when the pinned bytes differ', () => {
  const old = action()
  const newerBytes = new TextEncoder().encode('classes:\n  - class: regression-risk\n')
  const newerDigest = createHash('sha256').update(newerBytes).digest('hex')
  const newer = action('c'.repeat(40), newerDigest)
  const table = createReviewClassCatalogues([
    { ref: old.ref, contents: { ok: true, value: bytes } },
    { ref: newer.ref, contents: { ok: true, value: newerBytes } },
  ])
  expect(catalogueForAction(old.inputs, table)).toEqual({ ok: true, value: ['test-tautology'] })
  expect(catalogueForAction(newer.inputs, table)).toEqual({ ok: true, value: ['regression-risk'] })
})

it('rejects changed bytes and conflicting claims for the same Git coordinates', () => {
  const first = action()
  const forged = action('b'.repeat(40), 'f'.repeat(64))
  const bad = createReviewClassCatalogues([{ ref: forged.ref, contents: { ok: true, value: bytes } }])
  expect(catalogueForAction(forged.inputs, bad).ok).toBe(false)
  const conflict = createReviewClassCatalogues(
    [first, forged].map(({ ref }) => ({ ref, contents: { ok: true as const, value: bytes } })),
  )
  expect(catalogueForAction(first.inputs, conflict).ok).toBe(false)
  expect(catalogueForAction(forged.inputs, conflict).ok).toBe(false)
})

it('requires one canonical path and refuses malformed, empty or repeated classes', () => {
  const first = action()
  const manifest = { ...first.inputs.manifest, plugin: { ...first.inputs.manifest.plugin, files: [] } }
  expect(reviewClassCatalogueRef({ ...first.inputs, manifest, fingerprint: actionInputDigest(manifest) }).ok).toBe(
    false,
  )
  for (const files of [
    [{ ...first.ref, path: 'elsewhere/review-classes.yml' }],
    [{ ...first.ref, repository: 'other/repository' }],
    [{ ...first.ref, commit: 'c'.repeat(40) }],
    [first.ref, first.ref],
  ]) {
    const altered = { ...first.inputs.manifest, plugin: { ...first.inputs.manifest.plugin, files } }
    expect(
      reviewClassCatalogueRef({ ...first.inputs, manifest: altered, fingerprint: actionInputDigest(altered) }).ok,
    ).toBe(false)
  }
  expect(parseReviewClassCatalogue('not-a-catalogue').ok).toBe(false)
  expect(parseReviewClassCatalogue('  - class: test-tautology\n  - class: test-tautology\n').ok).toBe(false)
})

it('keeps failed reads scoped to one observation and never caches caller mutations', () => {
  const { inputs, ref } = action()
  const unavailable = createReviewClassCatalogues([
    { ref, contents: { ok: false, diagnostics: [{ code: 'unreadable', message: 'missing' }] } },
  ])
  expect(catalogueForAction(inputs, unavailable).ok).toBe(false)
  const available = createReviewClassCatalogues([{ ref, contents: { ok: true, value: bytes } }])
  const result = catalogueForAction(inputs, available)
  if (!result.ok) throw new Error('Expected verified catalogue')
  expect(Object.isFrozen(result.value)).toBe(true)
  expect(catalogueForAction(inputs, available)).toEqual({ ok: true, value: ['test-tautology'] })
})
