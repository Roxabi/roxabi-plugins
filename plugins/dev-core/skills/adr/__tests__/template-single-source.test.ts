/**
 * WS1 guard — one file defines the ADR frontmatter and section skeleton.
 *
 * The skill and the axial path each carried their own inlined copy, and the
 * copies drifted: the skill emitted `title` + `description`, the axial path
 * emitted those plus `axial: true`, and list mode read `status` + `date` that
 * neither wrote. These assertions fail on a second embedded copy and on any
 * vocabulary that stops agreeing with the template.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ADR_STATUSES } from '../lib/adr'

const PLUGINS = join(import.meta.dirname, '..', '..', '..', '..')
const SKILL_DIR = join(PLUGINS, 'dev-core', 'skills', 'adr')
const TEMPLATE = join(SKILL_DIR, 'references', 'adr-template.md')
const HYGIENE = join(PLUGINS, 'dev-core', 'scripts', 'check-agents-adr-hygiene.sh')

/** The skeleton's own title line — present in a template, absent from a pointer. */
const SKELETON_MARKER = /^title: "ADR-\{NNN\}/m

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...markdownFiles(full))
    else if (entry.name.endsWith('.md')) out.push(full)
  }
  return out
}

/** Backticked tokens inside the template's vocabulary markers. */
function templateVocabulary(): string[] {
  const block = /<!-- adr:status-vocabulary -->([\s\S]*?)<!-- \/adr:status-vocabulary -->/.exec(
    readFileSync(TEMPLATE, 'utf-8'),
  )
  if (!block) throw new Error('adr-template.md lost its status-vocabulary markers')
  return [...block[1].matchAll(/`([a-z]+)`/g)].map((m) => m[1])
}

describe('ADR template is single-source', () => {
  it('is the only file under plugins/ that embeds the skeleton', () => {
    const carriers = markdownFiles(PLUGINS).filter((f) => SKELETON_MARKER.test(readFileSync(f, 'utf-8')))

    expect(carriers).toEqual([TEMPLATE])
  })

  it('is pointed at by every writer instead of restated', () => {
    const writers = [join(SKILL_DIR, 'SKILL.md'), join(SKILL_DIR, 'references', 'axial-interview.md')]

    for (const writer of writers) {
      expect(readFileSync(writer, 'utf-8')).toContain('adr-template.md')
    }
  })

  it('defines the status vocabulary the library uses', () => {
    expect(templateVocabulary()).toEqual([...ADR_STATUSES])
  })

  it('defines the status vocabulary the hygiene gate enforces', () => {
    const declared = /^STATUSES="([^"]+)"/m.exec(readFileSync(HYGIENE, 'utf-8'))
    expect(declared).not.toBeNull()
    expect(declared?.[1].split(/\s+/)).toEqual(templateVocabulary())
  })

  it('leaves no `## Status` body section for a writer to emit', () => {
    const writers = [TEMPLATE, join(SKILL_DIR, 'SKILL.md'), join(SKILL_DIR, 'references', 'axial-interview.md')]

    for (const writer of writers) {
      const skeletonHeadings = readFileSync(writer, 'utf-8')
        .split('\n')
        .filter((l) => /^##\s+Status\s*$/.test(l))
      expect(skeletonHeadings).toEqual([])
    }
  })
})

/**
 * A superseded axial ADR keeps its title and its `## Decision` prose when it
 * moves to `archived/`; only `axial: true` is stripped. Any resolver that also
 * matches body prose therefore finds two "axial" ADRs on a correctly-archived
 * corpus and blocks the review path it is supposed to enable.
 */
const ARCHIVED_AXIAL = [
  '---',
  'title: "ADR-001: Axis of Decomposition"',
  'description: Primary axis chosen for system variation',
  'status: superseded',
  'normative: false',
  'date: 2026-01-01',
  'superseded_by: ADR-002',
  '---',
  '',
  '## Context',
  '',
  'Without an explicit axis of decomposition, code drifts along the wrong axis.',
  '',
  '## Decision',
  '',
  '**Primary axis:** `targets`',
].join('\n')

describe('axial resolvers', () => {
  /** The read-only agents that still resolve the singleton by grepping. */
  const grepResolvers = [
    join(PLUGINS, 'dev-core', 'agents', 'R-architect.md'),
    join(PLUGINS, 'omp-build', 'agents', 'R-architect.md'),
  ]

  function documentedPatterns(file: string): string[] {
    const patterns = [...readFileSync(file, 'utf-8').matchAll(/pattern[=:]\s*"([^"]*axial[^"]*)"/g)].map((m) => m[1])
    expect(patterns.length, `${file} documents no axial pattern`).toBeGreaterThan(0)
    return patterns
  }

  it('document a pattern that an archived axial ADR no longer answers', () => {
    for (const file of grepResolvers) {
      for (const pattern of documentedPatterns(file)) {
        expect(new RegExp(pattern, 'im').test(ARCHIVED_AXIAL), `${file}: /${pattern}/`).toBe(false)
      }
    }
  })

  it('document a pattern that the live axial ADR does answer', () => {
    const live = ARCHIVED_AXIAL.replace('status: superseded', 'status: accepted').replace(
      'superseded_by: ADR-002',
      'axial: true',
    )

    for (const file of grepResolvers) {
      for (const pattern of documentedPatterns(file)) {
        expect(new RegExp(pattern, 'im').test(live), `${file}: /${pattern}/`).toBe(true)
      }
    }
  })

  it('resolve the singleton through the CLI in dev-init, not a second grep', () => {
    const skill = readFileSync(join(PLUGINS, 'dev-core', 'skills', 'dev-init', 'SKILL.md'), 'utf-8')

    expect(skill).toContain('adr.ts axial')
    expect(skill).not.toMatch(/pattern[=:]\s*"[^"]*axial[^"]*"/)
  })
})
