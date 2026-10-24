import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { CommandEvidence, Facts, ParseYaml, StackAddition, StackProposal } from './feature-init-types'

export type { CommandEvidence, StackAddition, StackProposal } from './feature-init-types'

import { discoverTestCommands } from './feature-init-test-commands'
import { bunYamlParse, isMap, type YamlMap } from './feature-init-yaml'

export function isPrincipal(dir: string): boolean {
  const out = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' })
  const first = out.match(/^worktree (.+)$/m)?.[1]
  if (!first) return true
  const here = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim()
  // Match scripts/check-principal-branch.sh: compare physical paths, not symlink spellings.
  try {
    return realpathSync(here) === realpathSync(first)
  } catch {
    return here === first
  }
}

function hasOwn(map: YamlMap, key: string): boolean {
  return Object.hasOwn(map, key)
}

function rootMappingLines(text: string, key: string): number[] {
  return text.split('\n').flatMap((line, index) => (new RegExp(`^${key}:\\s*(?:#.*)?$`).test(line) ? [index] : []))
}

function manifestCommandUnknowns(dir: string): string[] {
  return ['pyproject.toml', 'setup.py', 'go.mod', 'Cargo.toml'].filter((name) => existsSync(join(dir, name)))
}

type ProposalPhase = { additions: StackAddition[]; conflicts: string[]; refusal: string | null }

function worktreeAddition(): StackAddition {
  return {
    key: 'worktree',
    text: 'worktree:\n  copy: []\n  seed: []\n  setup: ""\n',
    source: '.dev/stack.yml: missing worktree',
  }
}

function landingAddition(): StackAddition {
  return {
    key: 'landing',
    text: 'landing:\n  mode: merge-on-green\n',
    source: '.github/workflows/merge-on-green.yml',
  }
}

function missingStackProposal(facts: Facts): StackProposal {
  const additions = [
    ...(facts.hasWorktree ? [] : [worktreeAddition()]),
    ...(facts.mergeOnGreen ? [landingAddition()] : []),
  ]
  const after = additions.length
    ? `schema_version: "1.0"\n${additions.map((addition) => `\n${addition.text}`).join('')}`
    : null
  return { additions, conflicts: [], refusal: null, before: null, after }
}

function parseExistingStack(before: string, parseYaml: ParseYaml): { config: YamlMap } | StackProposal {
  const firstContent = before.split('\n').find((line) => line.trim() && !line.trimStart().startsWith('#')) ?? ''
  if (/^\s*[{[]/.test(firstContent) || /^\s*\.\.\.\s*$/.test(before)) {
    return {
      additions: [],
      conflicts: [],
      refusal: '.dev/stack.yml cannot be safely extended without reformatting',
      before,
      after: null,
    }
  }
  let config: unknown
  try {
    config = parseYaml(before)
  } catch {
    return {
      additions: [],
      conflicts: [],
      refusal: '.dev/stack.yml is unreadable',
      before,
      after: null,
    }
  }
  if (isMap(config)) return { config }
  return {
    additions: [],
    conflicts: [],
    refusal: '.dev/stack.yml root is not a mapping',
    before,
    after: null,
  }
}

function emptyTestsPhase(dir: string): ProposalPhase {
  const manifests = manifestCommandUnknowns(dir)
  return {
    additions: [],
    conflicts: manifests.length
      ? [`commands.test withheld: no executable test command in ${manifests.join(', ')}`]
      : [],
    refusal: null,
  }
}

function singleTestPhase(before: string, commands: unknown, evidence: CommandEvidence): ProposalPhase {
  if (commands !== undefined && !isMap(commands)) {
    return { additions: [], conflicts: ['commands exists with a non-mapping value'], refusal: null }
  }
  if (isMap(commands) && hasOwn(commands, 'test')) {
    return { additions: [], conflicts: ['commands.test preserved'], refusal: null }
  }
  if (commands !== undefined && rootMappingLines(before, 'commands').length !== 1) {
    return { additions: [], conflicts: [], refusal: '.dev/stack.yml commands block is not uniquely locatable' }
  }
  return {
    additions: [
      {
        key: 'commands.test',
        text:
          commands === undefined
            ? `commands:\n  test: ${JSON.stringify(evidence.command)}\n`
            : `  test: ${JSON.stringify(evidence.command)}\n`,
        source: evidence.source,
      },
    ],
    conflicts: [],
    refusal: null,
  }
}

function testPhase(dir: string, config: YamlMap, before: string): ProposalPhase {
  const evidence = discoverTestCommands(dir)
  const commands = [...new Set(evidence.map((candidate) => candidate.command))]
  if (commands.length === 0) {
    const empty = emptyTestsPhase(dir)
    if (isMap(config.commands) && hasOwn(config.commands, 'test')) empty.conflicts.unshift('commands.test preserved')
    return empty
  }
  if (commands.length > 1) {
    return {
      additions: [],
      conflicts: [`commands.test withheld: independent test commands (${commands.join(' ; ')})`],
      refusal: null,
    }
  }
  return singleTestPhase(before, config.commands, evidence[0])
}

function worktreePhase(config: YamlMap): ProposalPhase {
  if (hasOwn(config, 'worktree')) {
    return isMap(config.worktree)
      ? { additions: [], conflicts: [], refusal: null }
      : { additions: [], conflicts: ['worktree exists with a non-mapping value'], refusal: null }
  }
  const setup = isMap(config.commands) ? config.commands.worktree_setup : undefined
  return typeof setup === 'string' && setup.trim()
    ? { additions: [], conflicts: ['worktree preserved: commands.worktree_setup is declared'], refusal: null }
    : { additions: [worktreeAddition()], conflicts: [], refusal: null }
}

function landingPhase(config: YamlMap, facts: Facts): ProposalPhase {
  if (!facts.mergeOnGreen) return { additions: [], conflicts: [], refusal: null }
  if (!hasOwn(config, 'landing')) return { additions: [landingAddition()], conflicts: [], refusal: null }
  return isMap(config.landing)
    ? { additions: [], conflicts: [], refusal: null }
    : { additions: [], conflicts: ['landing exists with a non-mapping value'], refusal: null }
}

function renderAdditions(before: string, additions: StackAddition[], commands: unknown): string {
  let after = before
  const nested = additions.find((addition) => addition.key === 'commands.test' && commands !== undefined)
  if (nested) {
    const lines = after.split('\n')
    const start = rootMappingLines(after, 'commands')[0]
    const end = lines.findIndex((line, index) => index > start && /^[^\s]/.test(line))
    lines.splice(end === -1 ? lines.length - 1 : end, 0, nested.text.trimEnd())
    after = lines.join('\n')
  }
  const suffix = additions
    .filter((addition) => addition !== nested)
    .map((addition) => `${after.endsWith('\n') ? '\n' : '\n\n'}${addition.text}`)
    .join('')
  return `${after}${suffix}`
}

/** A textual, comment-preserving stack proposal. It never serializes YAML. */
export function proposeStack(dir: string, facts: Facts, parseYaml: ParseYaml = bunYamlParse): StackProposal {
  const stackPath = join(dir, '.dev', 'stack.yml')
  const before = existsSync(stackPath) ? readFileSync(stackPath, 'utf8') : null
  if (before === null) return missingStackProposal(facts)
  const parsed = parseExistingStack(before, parseYaml)
  if (!('config' in parsed)) return parsed
  const tests = testPhase(dir, parsed.config, before)
  if (tests.refusal) return { additions: [], conflicts: tests.conflicts, refusal: tests.refusal, before, after: null }
  const phases = [tests, worktreePhase(parsed.config), landingPhase(parsed.config, facts)]
  const additions = phases.flatMap((phase) => phase.additions)
  const conflicts = phases.flatMap((phase) => phase.conflicts)
  if (['commands', 'worktree', 'landing'].some((key) => rootMappingLines(before, key).length > 1)) {
    return { additions: [], conflicts, refusal: '.dev/stack.yml has ambiguous top-level mappings', before, after: null }
  }
  return {
    additions,
    conflicts,
    refusal: null,
    before,
    after: renderAdditions(before, additions, parsed.config.commands),
  }
}

export function applyStack(dir: string, facts: Facts, parseYaml: ParseYaml = bunYamlParse): void {
  const proposal = proposeStack(dir, facts, parseYaml)
  if (proposal.refusal || proposal.after === null || proposal.before === proposal.after) return
  const stackPath = join(dir, '.dev', 'stack.yml')
  mkdirSync(dirname(stackPath), { recursive: true })
  writeFileSync(stackPath, proposal.after)
}
