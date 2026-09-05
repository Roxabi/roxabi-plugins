import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// One writable changelog surface (GitHub Releases). Two of them produced ~30 releases
// of drift: entries piled up under `## Unreleased` while v0.5.0 … v4.0.1 shipped, so the
// heading was false for most of its content. This guard is what stops it regrowing —
// nothing else in the repo notices a hand-written entry.

const ROOT = path.resolve(import.meta.dirname, '../..')
const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
const convention = readFileSync(path.join(ROOT, 'docs/release-convention.md'), 'utf8')

describe('CHANGELOG.md is an archive, not a live changelog', () => {
  it('has no live Unreleased section to accumulate under', () => {
    expect(changelog).not.toMatch(/^##\s+Unreleased\s*$/im)
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

  // finalize.ts compares a `heading` witness against the derived version. It is null
  // here on purpose: trunk derives the version AT merge (price.sh) and cannot stamp a
  // heading afterwards (1-parent push to main = REFUSE, D3). Without this recorded,
  // the next reader "fixes" the null and every release starts warning.
  it('records why the finalize heading witness stays null', () => {
    expect(convention).toMatch(/heading.{0,40}witness/i)
    expect(convention).toMatch(/D3/)
    expect(convention).toMatch(/D4/)
    expect(convention).toMatch(/deliberate/i)
  })
})
