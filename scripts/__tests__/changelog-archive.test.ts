import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// One writable changelog surface (GitHub Releases). Two of them produced ~30 releases of
// drift: entries piled up under `## Unreleased` while v0.5.0 … v4.0.1 shipped.
//
// The priced quantity is "entries stop piling up", NOT "the token `## Unreleased` is
// absent". A heading denylist is bypassed by `## [Unreleased]`, `## Unreleased — pending`,
// a fresh `### Fixed` block, or simply appending under the archive's own heading — the
// pile grows and the denylist stays green. So the oracle is a byte-freeze of the archive
// region: any added line above `## [0.4.0]` changes the digest.
//
// Legitimately editing the archive (typo, dead link) means updating ARCHIVE_SHA256 in the
// same commit. That is the intended friction: the diff shows an archive edit.

const ROOT = path.resolve(import.meta.dirname, '../..')
const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')

const ARCHIVE_START = '## Unversioned'
/** First heading produced when a version was known before the merge (release-please / /promote). */
const ARCHIVE_END = '## [0.4.0]'
const ARCHIVE_SHA256 = '6c6c05948a4ae3ddab1ff98319f1f213796adfa16b44d1135e915a71baca1e02'

function archiveRegion(): string {
  const start = changelog.search(/^## Unversioned(?:\s|$)/m)
  const end = changelog.search(/^## \[0\.4\.0\]/m)
  // Without this the slice below silently yields '' or the whole file and the digest
  // assert becomes a statement about nothing — the failure mode this suite exists to stop.
  expect(start, `${ARCHIVE_START} heading not found`).toBeGreaterThan(-1)
  expect(end, `${ARCHIVE_END} heading not found`).toBeGreaterThan(start)
  return changelog.slice(start, end)
}

describe('CHANGELOG.md is a frozen archive, not a live changelog', () => {
  it('archive region is byte-identical — a new entry anywhere above [0.4.0] fails', () => {
    const region = archiveRegion()
    expect(createHash('sha256').update(region).digest('hex')).toBe(ARCHIVE_SHA256)
  })
})
