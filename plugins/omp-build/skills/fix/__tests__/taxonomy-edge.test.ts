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
const FALSIFY = readFileSync(path.join(SKILLS, 'fix', 'falsification.md'), 'utf8')

/** The partition shape `dev-review` Phase 4 forbids inside the roll-up blocks. */
const CC_SHAPE = /^\s*[-*]?\s*(issue|suggestion|todo|nitpick|thought|question|praise)(\([a-z-]+\))?:/

/** Lines after `## <heading>` up to the next `##` heading, plus that heading. */
function section(text: string, heading: string): { body: string[]; next: string | undefined } {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  if (start < 0) throw new Error(`no ${heading} line`)
  const end = lines.findIndex((line, i) => i > start && /^## /.test(line))
  return { body: lines.slice(start + 1, end < 0 ? undefined : end), next: end < 0 ? undefined : lines[end] }
}

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
  it('requires --title-file/--body-file and forbids raw gh issue create', () => {
    // This pin keeps the file-argv / no-raw-gh rules only. Prose routing at the
    // Filing instruction line is not asserted here — the Filing behaviour test
    // covers the fenced block operators paste, not the surrounding sentence.
    expect(FIX).toContain('--title-file')
    expect(FIX).toContain('--body-file')
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

describe('fix applies root causes, one decision per cause', () => {
  it('runs a pipeline with no per-finding walkthrough phase', () => {
    const table = /## Pipeline\n([\s\S]*?)\n## /.exec(FIX)?.[1] ?? ''
    const ids = [...table.matchAll(/^\| \d+ \| ([a-z-]+) \|/gm)].map((m) => m[1])
    expect(ids).toEqual(['gather', 'causes', 'apply', 'falsify', 'push', 'post-comment'])
  })

  it('reads the shared rules through skill://, never through SKILL_DIR', () => {
    expect(FIX).toContain('Read `skill://dev-review/root-causes.md`.')
    expect(REVIEW).toContain('Read `skill://dev-review/root-causes.md`.')
    expect(FIX).not.toContain('SKILL_DIR')
  })
})

describe('fix reads one attributable review record', () => {
  const mark = /MARK := `([^`]+)`/.exec(FIX)?.[1]

  it('takes the newest marked comment by the running account, by its first line', () => {
    expect(mark).toBe('<!-- omp-build:code-review -->')
    expect(FIX).toMatch(/newest comment whose \*\*first line\*\* is exactly MARK and whose `author\.login` = ME/)
  })

  it('uses the marker dev-review writes on the first line of the review', () => {
    expect(REVIEW).toContain(`Its first line is exactly \`${mark}\``)
  })

  it('closes Root causes before any finding in the normative review comment', () => {
    const example = /\*\*Comment shape[^\n]*\n\n```markdown\n([\s\S]*?)\n```/.exec(REVIEW)?.[1] ?? ''
    expect(example.split('\n')[0]).toBe(mark)
    const { body, next } = section(example, '## Root causes')
    expect(next).toBe('## Findings')
    expect(body.filter((line) => CC_SHAPE.test(line))).toEqual([])
  })
})

describe('fix decides eligibility where the human used to', () => {
  it('sends filed titles and bodies through files, never argv', () => {
    expect(FIX).toContain('--title-file "$FILE_DIR/title.txt"')
    expect(FIX).toContain('--body-file "$FILE_DIR/body.md"')
    expect(FIX).not.toMatch(/--(title|body) "/)
  })
})

describe('falsification counts causes', () => {
  it('retries once per cause and reverts on a second fail', () => {
    expect(FIX).toContain('max 1 falsification-retry per cause')
    expect(FALSIFY).toContain('falsification-retry per cause')
    expect(FALSIFY).toMatch(/Second `fail` → `git revert --no-edit` the cause's commits/)
    expect(FALSIFY).not.toMatch(/per finding|RC-1/)
  })
})
