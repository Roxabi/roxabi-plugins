import { type AgentOverride, DISPATCHABLE, type RosterConfig } from './roster-contract'
import { blockEnd, parseInteger, parseYamlLines } from './roster-yaml'

const DEFAULT_MAX_AGENTS = 3
const KNOWN_AGENTS: Record<string, true> = Object.fromEntries(DISPATCHABLE.map((agent) => [agent, true]))
const OVERRIDE_VALUES: Record<string, true> = { default: true, always: true, never: true }
/** A key parsed, warned about, and dropped — never silently ignored. The two domain
 *  roles and the fixer are not absent by oversight here: they are cut (ADR-020 §7),
 *  and a project carrying them in `.dev/stack.yml` must be told, not have its pin
 *  vanish into an `unknown roster agent` line that reads like a typo. */
const REMOVED_AGENTS: Record<string, true> = {
  'R-axial-adr-review': true,
  'R-recall': true,
  'R-finding-verifier': true,
  'R-options': true,
  'R-frontend-dev': true,
  'R-backend-dev': true,
  'R-fixer': true,
}
const REMOVED_AGENT_WARNINGS: Record<string, string> = {
  'R-recall': 'R-recall override ignored; recall is no longer a roster agent',
  'R-finding-verifier': 'R-finding-verifier override ignored; confidence-only finding removal was retired',
  'R-options': 'R-options override ignored; options is an /R-analyze host-native worker',
  'R-frontend-dev': 'R-frontend-dev override ignored; the domain roles are cut — R-adversarial owns their concerns',
  'R-backend-dev': 'R-backend-dev override ignored; the domain roles are cut — R-adversarial owns their concerns',
  'R-fixer': 'R-fixer override ignored; /fix uses dedicated native correction profiles, not the review roster',
}

type YamlLine = { indent: number; key: string; value: string }
type RosterState = {
  maxAgents: number
  axialOverride: AgentOverride
  overrides: Record<string, AgentOverride>
  warnings: string[]
}

export function createRosterDefaults(): RosterConfig {
  return {
    maxAgents: DEFAULT_MAX_AGENTS,
    axialOverride: 'default',
    overrides: Object.create(null),
    warnings: [],
  }
}

export function parseRosterConfigText(text: string, defaults: RosterConfig): RosterConfig {
  const lines = parseYamlLines(text)
  const reviewIndexes = topLevelReviewIndexes(lines)
  if (!reviewIndexes.length) {
    return lines.some((line) => line.indent === 0 && line.key === 'roster')
      ? { ...defaults, warnings: ['review.roster missing'] }
      : defaults
  }

  const warnings: string[] = []
  if (reviewIndexes.length > 1) warnings.push('duplicate top-level review: block ignored')
  const reviewIndex = reviewIndexes[0]
  const rosterIndex = reviewRosterIndex(lines, reviewIndex)
  if (rosterIndex < 0) return { ...defaults, warnings: [...warnings, 'review.roster missing'] }

  return parseRosterBlock(lines, rosterIndex, warnings)
}

function topLevelReviewIndexes(lines: YamlLine[]): number[] {
  const indexes: number[] = []
  for (let index = 0; index < lines.length; index++) {
    if (lines[index].indent === 0 && lines[index].key === 'review') indexes.push(index)
  }
  return indexes
}

function reviewRosterIndex(lines: YamlLine[], reviewIndex: number): number {
  const reviewEnd = blockEnd(lines, reviewIndex)
  for (let index = reviewIndex + 1; index < reviewEnd; index++) {
    if (lines[index].key === 'roster' && lines[index].indent > lines[reviewIndex].indent) return index
  }
  return -1
}

function parseRosterBlock(lines: YamlLine[], rosterIndex: number, warnings: string[]): RosterConfig {
  const rosterIndent = lines[rosterIndex].indent
  const rosterEnd = blockEnd(lines, rosterIndex)
  const children = lines.slice(rosterIndex + 1, rosterEnd).filter((line) => line.indent > rosterIndent)
  const state = createRosterState(warnings)
  if (!children.length) return state

  const directIndent = Math.min(...children.map((line) => line.indent))
  return parseDirectRosterEntries(lines, rosterIndex, rosterEnd, directIndent, state)
}

function createRosterState(warnings: string[]): RosterState {
  return {
    maxAgents: DEFAULT_MAX_AGENTS,
    axialOverride: 'default',
    overrides: Object.create(null),
    warnings,
  }
}

function parseDirectRosterEntries(
  lines: YamlLine[],
  rosterIndex: number,
  rosterEnd: number,
  directIndent: number,
  state: RosterState,
): RosterConfig {
  const consumed = new Set<number>()
  for (let index = rosterIndex + 1; index < rosterEnd; index++) {
    if (lines[index].indent !== directIndent) continue
    parseDirectRosterEntry(lines, index, consumed, state)
  }
  appendUnrecognisedRosterWarnings(lines, rosterIndex, rosterEnd, consumed, state.warnings)
  return state
}

function parseDirectRosterEntry(lines: YamlLine[], index: number, consumed: Set<number>, state: RosterState): void {
  const line = lines[index]
  switch (line.key) {
    case 'max_agents':
      consumed.add(index)
      state.maxAgents = parseMaxAgents(line.value, state.warnings)
      return
    case 'verify_below_confidence':
      consumed.add(index)
      state.warnings.push(
        'verify_below_confidence is deprecated and ignored; deterministic deduplication retains findings',
      )
      return
    case 'recall_min_delta':
      consumed.add(index)
      state.warnings.push(
        'recall_min_delta is deprecated and ignored; /R-dev-review controls the isolated recall worker',
      )
      return
    case 'max_agents_review':
      consumed.add(index)
      state.warnings.push('max_agents_review is deprecated and ignored; use the per-chunk max_agents cap')
      return
    case 'agents':
      consumed.add(index)
      parseAgentOverrides(lines, index, consumed, state)
      return
  }
}

function parseMaxAgents(value: string, warnings: string[]): number {
  const maxAgents = parseInteger(value, DEFAULT_MAX_AGENTS, 'max_agents', warnings)
  if (maxAgents < 1) {
    warnings.push('max_agents < 1; clamped to 1')
    return 1
  }
  return maxAgents
}

function parseAgentOverrides(lines: YamlLine[], agentsIndex: number, consumed: Set<number>, state: RosterState): void {
  const agentsEnd = blockEnd(lines, agentsIndex)
  let recognised = 0
  let legacyArchitectOverride: AgentOverride | undefined
  for (let index = agentsIndex + 1; index < agentsEnd; index++) {
    if (lines[index].indent <= lines[agentsIndex].indent) break
    consumed.add(index)
    recognised++
    const legacyOverride = parseAgentOverride(lines[index], state)
    if (legacyOverride !== undefined) legacyArchitectOverride = legacyOverride
  }
  applyLegacyArchitectOverride(legacyArchitectOverride, state)
  if (recognised === 0) {
    state.warnings.push('roster agents block present but no key: value entries recognised (sequence or flow mapping?)')
  }
}

function parseAgentOverride(line: YamlLine, state: RosterState): AgentOverride | undefined {
  const { key: agent, value } = line
  const raw = value.toLowerCase()
  if (agent === 'R-product-lead') {
    state.warnings.push('R-product-lead is not part of the review roster — Phase 2 covers spec compliance')
    return undefined
  }
  if (Object.hasOwn(REMOVED_AGENTS, agent)) return parseRemovedAgentOverride(agent, value, raw, state.warnings)
  if (!Object.hasOwn(KNOWN_AGENTS, agent)) {
    state.warnings.push(`unknown roster agent: ${agent}`)
    return undefined
  }
  if (!Object.hasOwn(OVERRIDE_VALUES, raw)) {
    state.warnings.push(`invalid override for ${agent}: ${value}; using default`)
    return undefined
  }
  state.overrides[agent] = raw as AgentOverride
  return undefined
}

function parseRemovedAgentOverride(
  agent: string,
  value: string,
  raw: string,
  warnings: string[],
): AgentOverride | undefined {
  warnings.push(`deprecated roster agent override: ${agent}`)
  if (!Object.hasOwn(OVERRIDE_VALUES, raw)) {
    warnings.push(`invalid override for ${agent}: ${value}; ignored`)
    return undefined
  }
  if (agent === 'R-axial-adr-review') return raw as AgentOverride
  warnings.push(REMOVED_AGENT_WARNINGS[agent])
  return undefined
}

function applyLegacyArchitectOverride(legacyOverride: AgentOverride | undefined, state: RosterState): void {
  if (legacyOverride === undefined) return
  state.axialOverride = legacyOverride
  const architectOverride = state.overrides['R-architect']
  state.warnings.push('R-axial-adr-review override applies to R-architect axial mode only; rename the key')
  if (!hasConflictingArchitectOverrides(architectOverride, legacyOverride)) return
  state.warnings.push(
    `conflicting R-architect (${architectOverride}) and R-axial-adr-review (${legacyOverride}) overrides; R-architect takes global precedence`,
  )
}

function hasConflictingArchitectOverrides(
  architectOverride: AgentOverride | undefined,
  legacyOverride: AgentOverride,
): boolean {
  return (
    architectOverride !== undefined &&
    architectOverride !== 'default' &&
    legacyOverride !== 'default' &&
    architectOverride !== legacyOverride
  )
}

function appendUnrecognisedRosterWarnings(
  lines: YamlLine[],
  rosterIndex: number,
  rosterEnd: number,
  consumed: Set<number>,
  warnings: string[],
): void {
  for (let index = rosterIndex + 1; index < rosterEnd; index++) {
    if (consumed.has(index)) continue
    warnings.push(`unrecognised roster key at indent ${lines[index].indent}: ${lines[index].key}`)
  }
}
