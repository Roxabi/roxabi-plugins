import { createHash } from 'node:crypto'
import { validateActionInputs } from './action-input.ts'
import type { ActionInputs, PinnedFileRef } from './action-input-schema.ts'
import type { Result } from './result.ts'

export type ReviewCatalogueRead = Readonly<{ ref: PinnedFileRef; contents: Result<Uint8Array> }>

type CatalogueResult = Result<readonly string[]>
class CatalogueTable {
  readonly #values: ReadonlyMap<string, CatalogueResult>

  constructor(values: ReadonlyMap<string, CatalogueResult>) {
    this.#values = values
    Object.freeze(this)
  }

  lookup(id: string): CatalogueResult | undefined {
    const result = this.#values.get(id)
    if (result === undefined) return undefined
    return result.ok
      ? { ok: true, value: result.value }
      : { ok: false, diagnostics: result.diagnostics.map((item) => ({ ...item })) }
  }
}

export type ReviewClassCatalogues = CatalogueTable

const key = (ref: PinnedFileRef) => JSON.stringify([ref.repository, ref.commit, ref.path, ref.digest])
const coordinates = (ref: PinnedFileRef) => JSON.stringify([ref.repository, ref.commit, ref.path])
const failure = (message: string): CatalogueResult => ({ ok: false, diagnostics: [{ code: 'unreadable', message }] })

export function parseReviewClassCatalogue(contents: string): Result<readonly string[]> {
  const classes = [...contents.matchAll(/^\s*- class:\s*([a-z][a-z0-9-]*)\s*$/gm)].map((match) => match[1])
  if (classes.length === 0 || new Set(classes).size !== classes.length)
    return failure('Review class catalogue is empty or contains duplicate classes')
  return { ok: true, value: Object.freeze(classes) }
}

function parseRead(read: ReviewCatalogueRead): CatalogueResult {
  if (!read.contents.ok) return { ok: false, diagnostics: read.contents.diagnostics.map((item) => ({ ...item })) }
  if (createHash('sha256').update(read.contents.value).digest('hex') !== read.ref.digest)
    return failure('Review class catalogue digest does not match its pinned bytes')
  try {
    return parseReviewClassCatalogue(new TextDecoder('utf-8', { fatal: true }).decode(read.contents.value))
  } catch {
    return failure('Review class catalogue is not valid UTF-8')
  }
}

export function createReviewClassCatalogues(reads: readonly ReviewCatalogueRead[]): ReviewClassCatalogues {
  const coordinateDigests = new Map<string, Set<string>>()
  for (const read of reads) {
    const id = coordinates(read.ref)
    const digests = coordinateDigests.get(id) ?? new Set<string>()
    digests.add(read.ref.digest)
    coordinateDigests.set(id, digests)
  }
  const values = new Map<string, CatalogueResult>()
  for (const read of reads) {
    const id = key(read.ref)
    if ((coordinateDigests.get(coordinates(read.ref))?.size ?? 0) > 1)
      values.set(id, failure('Conflicting review class catalogue digests for the same Git coordinates'))
    else {
      const previous = values.get(id)
      if (previous?.ok === false) continue
      const result = parseRead(read)
      if (!result.ok || previous === undefined) values.set(id, result)
    }
  }
  return new CatalogueTable(values)
}

export function reviewClassCatalogueRef(inputs: ActionInputs): Result<PinnedFileRef> {
  const valid = validateActionInputs(inputs)
  if (!valid.ok) return valid
  const plugin = valid.value.manifest.plugin
  const path = `${plugin.root}/skills/dev-review/review-classes.yml`
  const refs = plugin.files.filter((ref) => ref.path === path)
  const ref = refs[0]
  if (refs.length !== 1 || ref === undefined || ref.repository !== plugin.repository || ref.commit !== plugin.commit)
    return {
      ok: false,
      diagnostics: [
        { code: 'unbound', message: 'Action does not contain exactly one catalogue file pinned to its plugin' },
      ],
    }
  return { ok: true, value: ref }
}

export function catalogueForAction(inputs: ActionInputs, catalogues: ReviewClassCatalogues): Result<readonly string[]> {
  const ref = reviewClassCatalogueRef(inputs)
  if (!ref.ok) return ref
  return catalogues.lookup(key(ref.value)) ?? failure('Pinned review class catalogue is unavailable')
}
