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

describe('omp-build agent roster', () => {
  const agents = loadAgents()

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

  it('never names an agent or skill that exists nowhere in the repo', () => {
    // The defect this catches: a Boundaries row routing work to `reviewer` /
    // `security-reviewer`, which exist in no plugin (PR #533 review). A
    // rename-driven sweep cannot find a name that was already wrong.
    //
    // Deliberate mentions of things absent *here* but real elsewhere stay
    // legal: `R-product-lead` is named precisely to say it is not in the
    // roster, and `R-pr` to say its falsify oracle is not snapshotted.
    const plugins = path.resolve(AGENTS_DIR, '..', '..')
    // Not every plugin ships agents or skills.
    const entries = (dir: string) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
    const known = new Set<string>()
    for (const plugin of readdirSync(plugins)) {
      for (const file of entries(path.join(plugins, plugin, 'agents'))) {
        if (!file.isFile()) continue
        const name = /^name:\s*(\S+)/m.exec(readFileSync(path.join(plugins, plugin, 'agents', file.name), 'utf8'))?.[1]
        if (name) known.add(name)
      }
      for (const dir of entries(path.join(plugins, plugin, 'skills'))) {
        if (!dir.isDirectory()) continue
        known.add(dir.name)
        known.add(`R-${dir.name}`)
      }
    }

    const strays: string[] = []
    for (const agent of agents) {
      for (const [, quoted] of agent.body.matchAll(
        /`(R-[a-z-]+|elon|adversarial|advisor|reviewer|security-reviewer)`/g,
      )) {
        if (!known.has(quoted)) strays.push(`${agent.file} → ${quoted}`)
      }
    }
    expect(strays).toEqual([])
  })

  it('cites no plugin-root token, in an agent body or a skill body', () => {
    // omp-build carries no `rewriteHarnessPaths` at all, so a
    // `${CLAUDE_PLUGIN_ROOT}` citation is a path that resolves nowhere (#529
    // class). Skill bodies are in scope for the same reason agent bodies are:
    // `/feature` dumps `skills/feature/SKILL.md` into the conversation verbatim
    // (`omp/index.ts`), so an unexpandable token there reaches the model too.
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
    // Frontmatter included: a dead citation is dead wherever it sits.
    expect(sources.length).toBeGreaterThan(agents.length)
    const cited = sources
      .filter(({ text }) => /\$\{CLAUDE_(PLUGIN_ROOT|SKILL_DIR)\}\S*\.md/.test(text.replace(STATED_ABSENT, '')))
      .map(({ file }) => file)
    expect(cited).toEqual([])
  })
})
