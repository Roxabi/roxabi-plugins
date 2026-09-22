import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `fix` owns one cross-skill edge and two prose invariants that nothing else
 * checks here.
 *
 * `tools/validate_plugins.py --check class-list-sync` compares the inline class
 * list against the YAML for **dev-core's** copy only — its paths are constants.
 * So omp-build's copy of that pair is unguarded by the validator, exactly like
 * `agents/` (see `agents/__tests__/roster.test.ts`), and the check lives here.
 */
const SKILLS = path.resolve(import.meta.dirname, '..', '..')
const FIX = readFileSync(path.join(SKILLS, 'fix', 'SKILL.md'), 'utf8')
const REVIEW = readFileSync(path.join(SKILLS, 'dev-review', 'SKILL.md'), 'utf8')
const CLASSES = path.join(SKILLS, 'dev-review', 'review-classes.yml')

/** `skill://<name>/<rel>` → the file it resolves to inside this plugin. */
function resolveSkillUrl(url: string): string {
  const match = /^skill:\/\/([a-z0-9-]+)\/(.+)$/.exec(url)
  if (!match) throw new Error(`not a skill:// asset URL: ${url}`)
  return path.join(SKILLS, match[1], match[2])
}

describe('fix → dev-review taxonomy edge', () => {
  it('cites the YAML by skill:// URL and that URL resolves to a shipped file', () => {
    expect(FIX).toContain('skill://dev-review/review-classes.yml')
    expect(existsSync(resolveSkillUrl('skill://dev-review/review-classes.yml'))).toBe(true)
  })

  it('HALTs on a missing or unparseable taxonomy instead of falling back to memory', () => {
    // The fallback is the bug: validating class[] against model memory passes a
    // hallucinated slug, and the whole point of the canonical list is that it
    // cannot be invented.
    expect(FIX).toMatch(/absent, unreadable, or parse error → \*\*HALT\*\*/)
    expect(FIX).toMatch(/taxonomy-error/)
  })

  it('keeps the inline class list in dev-review identical to the YAML slugs', () => {
    const yamlSlugs = [...readFileSync(CLASSES, 'utf8').matchAll(/^\s*-\s+class:\s*(\S+)\s*$/gm)].map((m) => m[1])
    expect(yamlSlugs.length).toBeGreaterThan(0)
    const inline = /Canonical classes \(use slug only\):\s+([^.\r\n]+)\./.exec(REVIEW)?.[1]
    expect(inline, 'spawn-template class list anchor').toBeDefined()
    const listed = (inline ?? '').split(',').map((s) => s.trim())
    expect([...listed].sort()).toEqual([...yamlSlugs].sort())
  })
})

describe('fix applies findings itself', () => {
  it('spawns no fixer, and says so where a reader would look for one', () => {
    expect(FIX).not.toContain('R-fixer agent')
    expect(FIX).not.toMatch(/agent:\s*"R-fixer"/)
    expect(FIX).toMatch(/There is no `R-fixer` in this plugin/)
    expect(FIX).toMatch(/inline/)
  })
})

describe('deferred follow-ups are siblings', () => {
  // docs/agents/issue-tracker.md § "Deferred follow-ups are siblings": the
  // deferral takes the ORIGIN'S parent and is blocked by the origin. Parenting
  // it to the origin builds the nested cascade that rule exists to prevent.
  it('routes the create through issue-triage, never raw gh', () => {
    expect(FIX).toContain('Skill(skill: "issue-triage:issue-triage")')
    expect(FIX).toMatch(/Never raw `gh issue create`/)
  })

  it('wires --parent to the origin’s parent and --blocked-by to the origin', () => {
    // Regex, not a quoted string: `${…}` here is shell text lifted out of the
    // markdown, and biome reads that shape in a plain string as a mistake.
    expect(FIX).toMatch(/`--blocked-by "#\$\{SOURCE_ISSUE\}"`/)
    expect(FIX).toMatch(/`--parent "#\$\{SOURCE_PARENT\}"`/)
    expect(FIX).toMatch(/`--parent "#\$\{SOURCE_ISSUE\}"` is the bug/)
    expect(FIX).toMatch(/sibling/)
  })

  it('degrades to a traceable top-level issue when there is no parent to share', () => {
    expect(FIX).toMatch(/∄ SOURCE_PARENT[^\n]*without `--parent`/)
    expect(FIX).toMatch(/\*\*Origin:\*\* PR #<N>/)
  })
})
