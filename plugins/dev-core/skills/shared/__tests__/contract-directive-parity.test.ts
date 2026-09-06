import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { STACK_YML } from '../../../hooks/lib/contract-paths.cjs'

// Since the CLAUDE.md `@`-import was dropped (it is Claude-Code-specific), nothing
// injects the contract into context: an agent or skill that interpolates a stack
// field MUST read `.dev/stack.yml` itself. The plausible bug is a NEW agent/skill
// that consumes `{commands.test}` without referencing the contract — the placeholder
// then ships unresolved into a shell command, silently.
//
// `skills/shared/references/base.md` states the rule for all agents, but nothing
// resolves `# based-on:` at runtime (agents inline the base protocol by hand — see
// plugins/dev-core/README.md), so the reference file cannot enforce it. This test is
// the enforcement.
//
// Scope: agent prompts and skill entry points. Cookbooks are excluded on purpose —
// they are dispatched by an owning SKILL.md, which carries the requirement (e.g.
// `release-setup/cookbooks/quality-gates.md` interpolates `{package_manager}` and is
// reached only through `release-setup/SKILL.md`). Same for
// `skills/dev-init/templates/**`, whose `{standards.x}` mentions are prose shipped
// into user projects, not instructions executed by an agent.
const DEV_CORE = fileURLToPath(new URL('../../..', import.meta.url))

/** Stack fields as they appear in agent/skill bodies: `{commands.test}`, `{runtime}`, … */
const STACK_FIELD =
  /\{(?:commands|backend|frontend|shared|standards|artifacts|build|deploy|docs|release|testing)\.[a-z_.]+\}|\{(?:package_manager|runtime)\}/

function walk(dir: string, match: (path: string) => boolean): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path, match))
    else if (match(path)) out.push(path)
  }
  return out
}

function contractConsumers(): Array<{ path: string; text: string }> {
  const agents = walk(join(DEV_CORE, 'agents'), (p) => p.endsWith('.md'))
  const skills = walk(join(DEV_CORE, 'skills'), (p) => p.endsWith('/SKILL.md'))
  return [...agents, ...skills]
    .map((path) => ({ path: path.slice(DEV_CORE.length), text: readFileSync(path, 'utf-8') }))
    .filter(({ text }) => STACK_FIELD.test(text))
}

describe('contract directive parity', () => {
  it('every agent/skill interpolating a stack field references the contract path', () => {
    const offenders = contractConsumers()
      .filter(({ text }) => !text.includes(STACK_YML))
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })

  it('finds consumers to check — the scan is not vacuously empty', () => {
    // Guards the inverse bug: a broken glob or field pattern would make the
    // assertion above pass by inspecting nothing.
    expect(contractConsumers().length).toBeGreaterThan(15)
  })
})
