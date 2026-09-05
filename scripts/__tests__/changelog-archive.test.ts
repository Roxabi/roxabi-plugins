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
const convention = readFileSync(path.join(ROOT, 'docs/release-convention.md'), 'utf8')

const ARCHIVE_START = '## Unversioned'
/** First heading produced when a version was known before the merge (release-please / /promote). */
const ARCHIVE_END = '## [0.4.0]'
const ARCHIVE_SHA256 = '6c6c05948a4ae3ddab1ff98319f1f213796adfa16b44d1135e915a71baca1e02'

function archiveRegion(): string {
  const start = changelog.indexOf(ARCHIVE_START)
  const end = changelog.indexOf(ARCHIVE_END)
  // Without this the slice below silently yields '' or the whole file and the digest
  // assert becomes a statement about nothing — the failure mode this suite exists to stop.
  expect(start, `${ARCHIVE_START} heading not found`).toBeGreaterThan(-1)
  expect(end, `${ARCHIVE_END} heading not found`).toBeGreaterThan(start)
  return changelog.slice(start, end)
}

describe('CHANGELOG.md is a frozen archive, not a live changelog', () => {
  it('archive region is byte-identical — a new entry anywhere above [0.4.0] fails', () => {
    const region = archiveRegion()
    expect(region.length).toBeGreaterThan(1000)
    expect(createHash('sha256').update(region).digest('hex')).toBe(ARCHIVE_SHA256)
  })

  it('no heading is inserted above the archive', () => {
    const header = changelog.slice(0, changelog.indexOf(ARCHIVE_START))
    expect(header).not.toMatch(/^##/m)
  })

  it('states where per-change prose goes instead', () => {
    expect(changelog).toMatch(/Do not add entries here/i)
    expect(changelog).toMatch(/PR body/)
  })
})

describe('release-convention documents the trunk-mode changelog contract', () => {
  it('names GitHub Releases as the source of truth', () => {
    const section = convention.slice(convention.indexOf('## Changelog'))
    expect(section).toMatch(/SSoT/)
    expect(section).toMatch(/GitHub Releases/)
  })

  // Cross-model carve-out. Retiring the changelog is a TRUNK decision: under staging-train
  // /R-promote step 3 writes the file and step 9b ships the section as the release body
  // (`--notes "$CHANGELOG_CONTENT"`, SKILL.md:363). A consumer who reads this policy as
  // "stop maintaining a changelog" would ship empty releases, so the scope stays stated.
  it('scopes the retirement to trunk and keeps staging-train maintaining its changelog', () => {
    const section = convention.slice(convention.indexOf('## Changelog'))
    expect(section).toMatch(/Scope: this repo only/)
    expect(section).toMatch(/staging-train/)
    expect(section).toMatch(/release body|--notes/)
  })

  // Why the null `heading` witness (finalize.ts:72-88) is a choice, not an omission: a
  // post-hoc heading is still the PREVIOUS version when the next release derives, so the
  // witness disagrees forever. Recorded so nobody "fixes" the null and reds every release.
  it('records why the finalize heading witness stays null', () => {
    expect(convention).toMatch(/heading.{0,40}witness/i)
    expect(convention).toMatch(/previous version/i)
    expect(convention).toMatch(/deliberate/i)
  })

  // The first rationale for this policy cited D3 for a failure it does not cause and called
  // in-tree cutting impossible. Both were false: D3 checks the parent count of the SHA being
  // released (auto-release.sh:44-51), so a 1-parent stamp reds only that run. Assert the
  // corrected reasons, not the absence of a word — "Not impossible" contains "impossible".
  it('cites the real blockers and exonerates D3', () => {
    const section = convention.slice(convention.indexOf('## Changelog'))
    expect(section).not.toMatch(/it cannot work/i)
    expect(section).not.toMatch(/break the next release/i)
    expect(section).toMatch(/D3 is ¬the blocker/)
    expect(section).toMatch(/rac(e|y)/i)
    expect(section).toMatch(/D18|price\.sh/)
  })
})
