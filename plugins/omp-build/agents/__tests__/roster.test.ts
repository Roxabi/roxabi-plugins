import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The roster is the one part of this plugin nothing else observes: no skill
 * imports it, and `tools/validate_plugins.py` never reads `agents/` — deleting
 * an agent leaves the validator fully green (PR #533 review). So the closure
 * checks live here.
 */
const AGENTS_DIR = path.resolve(import.meta.dirname, '..')

const EXPECTED = ['R-adversarial', 'R-advisor', 'R-architect', 'R-devops', 'R-security-auditor', 'R-tester', 'elon']

/** The one legal mention: a line that documents the token as *not* expanding here. */
const STATED_ABSENT = /^.*only expands in SKILL\.md.*$/gm

interface Agent {
  file: string
  name: string
  frontmatter: string
  body: string
}

function loadAgents(): Agent[] {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((file) => {
      const raw = readFileSync(path.join(AGENTS_DIR, file), 'utf8')
      const end = raw.indexOf('\n---\n', 4)
      if (!raw.startsWith('---\n') || end === -1) throw new Error(`${file}: no frontmatter`)
      const frontmatter = raw.slice(4, end)
      const name = /^name:\s*(\S+)/m.exec(frontmatter)?.[1]
      if (!name) throw new Error(`${file}: no name key`)
      return { file, name, frontmatter, body: raw.slice(end + 5) }
    })
}

/** Bundled by the host, resolvable without any plugin: naming one is legal here.
 *  `omp://task-agent-discovery.md` § Agent lookup. */
const HOST_BUNDLED = ['scout', 'task', 'sonic', 'reviewer', 'security-reviewer']

/** Deliberate mentions of roles this plugin does not carry — each says, in prose,
 *  that the role is absent: `R-frontend-dev`/`R-backend-dev`/`R-fixer` are the
 *  ADR-020 §7 cut, `R-product-lead` is named to say Phase 2 owns spec compliance,
 *  and `R-pr` to say its falsify oracle is not snapshotted. Removing one from
 *  this list must make the mention illegal, not silently legal. */
const STATED_ABSENT_ROLES = ['R-fixer', 'R-frontend-dev', 'R-backend-dev', 'R-product-lead', 'R-pr']

describe('omp-build agent roster', () => {
  const agents = loadAgents()
  // Skill bodies are in scope for the same reason agent bodies are: `/feature`
  // dumps `skills/feature/SKILL.md` into the conversation verbatim (`omp/index.ts`)
  // and `dev-review`'s body is the dispatch contract, so a name that resolves
  // nowhere reaches the model from either place (#535 F3).
  const skillsDir = path.resolve(AGENTS_DIR, '..', 'skills')
  const sources = [
    ...agents.map((agent) => ({ file: agent.file, text: `${agent.frontmatter}\n${agent.body}` })),
    ...readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
      .map((entry) => ({
        file: `skills/${entry.name}/SKILL.md`,
        text: readFileSync(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf8'),
      })),
  ]

  it('scans every skill body, and each carries content', () => {
    // Both closure checks below are `expect(strays).toEqual([])` shaped: an empty
    // corpus passes them. So pin the corpus. Every directory under `skills/` that
    // ships a SKILL.md must be in it, and each body must be substantial enough to
    // be the thing the model reads — an emptied file would otherwise turn a guard
    // green by deleting what it guards (#495).
    const onDisk = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
      .map((entry) => `skills/${entry.name}/SKILL.md`)
    const scanned = sources.map(({ file }) => file).filter((file) => file.startsWith('skills/'))
    expect(scanned.sort()).toEqual(onDisk.sort())
    // The tail landed in #495; naming them makes a *deleted directory* fail here
    // rather than silently shrink the corpus.
    expect(scanned).toEqual(expect.arrayContaining(['skills/promote/SKILL.md', 'skills/cleanup/SKILL.md']))
    for (const { file, text } of sources) expect(`${file} → ${text.trim().length > 400}`).toBe(`${file} → true`)
  })

  it('is exactly the seven ADR-020 keeps', () => {
    expect(agents.map((a) => a.name).sort()).toEqual([...EXPECTED].sort())
  })

  it('names the file after the agent', () => {
    for (const agent of agents) expect(agent.file).toBe(`${agent.name}.md`)
  })

  it('pins tools on every agent', () => {
    // A read-only posture asserted in prose and not in the manifest is not a
    // control — the deleted `adversarial.md` carried the pin and its
    // replacement arrived without one.
    for (const agent of agents) expect(agent.frontmatter).toMatch(/^tools:\s*\S/m)
  })

  it('never names an agent this plugin cannot resolve on its own', () => {
    // The defect this catches: a Boundaries row routing work to `reviewer` /
    // `security-reviewer`, which exist in no plugin (PR #533 review). A
    // rename-driven sweep cannot find a name that was already wrong.
    //
    // `known` is plugin-local on purpose. A repo-wide scan makes `R-doc-writer`
    // — a dev-core agent this plugin does not ship — legal in an omp-build body,
    // which is precisely the standalone-installability failure ADR-020 exists to
    // prevent: uninstall dev-core and the name resolves nowhere.
    const known = new Set<string>([...agents.map((agent) => agent.name), ...HOST_BUNDLED, ...STATED_ABSENT_ROLES])
    const strays: string[] = []
    for (const source of sources) {
      for (const [, quoted] of source.text.matchAll(
        /`(R-[a-z-]+|elon|adversarial|advisor|reviewer|security-reviewer|scout|sonic)`/g,
      )) {
        if (!known.has(quoted)) strays.push(`${source.file} → ${quoted}`)
      }
    }
    expect(strays).toEqual([])
  })

  it('cites no plugin-root token, in an agent body or a skill body', () => {
    // omp-build carries no `rewriteHarnessPaths` at all, so a
    // `${CLAUDE_PLUGIN_ROOT}` citation is a path that resolves nowhere (#529
    // class).
    // Frontmatter included: a dead citation is dead wherever it sits.
    expect(sources.length).toBeGreaterThan(agents.length)
    const cited = sources
      .filter(({ text }) => /\$\{CLAUDE_(PLUGIN_ROOT|SKILL_DIR)\}\S*\.md/.test(text.replace(STATED_ABSENT, '')))
      .map(({ file }) => file)
    expect(cited).toEqual([])
    // #577: the write path is `bun skill://issue-triage/triage.ts`, not a
    // plugin-root token and not a Skill() call. Those shapes are what the
    // model follows into a stale copy.
    const invoked = sources
      .filter(({ text }) => /\$\{CLAUDE_PLUGIN_ROOT\}/.test(text) || text.includes('Skill(skill:'))
      .map(({ file }) => file)
    expect(invoked).toEqual([])
  })
})
