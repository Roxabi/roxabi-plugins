import {
  type AgentOverride,
  type AllocateReviewInput,
  type AllocateReviewResult,
  type ComputeRosterInput,
  DISPATCHABLE,
  type GateRow,
  PHASE_AGENTS,
  type RosterResult,
  VALID_CLAIMS,
} from './roster-contract'
import { axialDeltaHit, infraHit, pathHit, sourceHit, structureHit, testHit } from './roster-signals'

type Gate = { spawn: boolean; reason: string; forced: boolean }

function applyOverride(agent: string, gate: Gate, overrides: Record<string, AgentOverride>, warnings: string[]): Gate {
  // `overrides` may be a caller-built literal (prototype-exposed), so read own keys only —
  // an inherited `constructor`/`toString` must never resolve as an override.
  const o = Object.hasOwn(overrides, agent) ? overrides[agent] : undefined
  if (agent === 'R-adversarial') {
    if (o === 'never') warnings.push('R-adversarial cannot be disabled')
    return { spawn: true, reason: 'floor', forced: true }
  }
  if (o === 'always') {
    // The reason carries the mode (`axial:` prefix) so the dispatch prompt can
    // read it; forced-ness rides the flag, never the spelling.
    return {
      spawn: true,
      reason: agent === 'R-architect' && gate.reason.startsWith('axial') ? 'axial:stack:always' : 'stack:always',
      forced: true,
    }
  }
  if (o === 'never') return { spawn: false, reason: 'stack:never', forced: false }
  return gate
}

/** Changed tests arm the role. So does an untested source change when τ ≠ S —
 *  the caller passes that as `untested`. A gate that only sees test files leaves
 *  a service-only diff with no tester. */
function testerGate(deltaTestHit: boolean, untested: boolean): Gate {
  if (deltaTestHit) return { spawn: true, reason: 'test-delta', forced: false }
  if (untested) return { spawn: true, reason: 'untested-change', forced: false }
  return { spawn: false, reason: 'no-test-delta', forced: false }
}

function architectGate(axialAdr: boolean, delta: string[], structural: boolean, axialOverride: AgentOverride): Gate {
  // `axial: always` is an operator pin exactly like `agents: R-architect: always`,
  // so it is forced too — same flag, one meaning.
  if (axialOverride === 'always' && axialAdr && axialDeltaHit(delta)) {
    return { spawn: true, reason: 'axial:stack:always', forced: true }
  }
  if (axialOverride !== 'never' && axialAdr && axialDeltaHit(delta)) {
    return { spawn: true, reason: 'axial:adr-delta', forced: false }
  }
  if (structural) return { spawn: true, reason: 'structure', forced: false }
  return { spawn: false, reason: 'no-structure', forced: false }
}

function devopsGate(infra: boolean): Gate {
  if (infra) return { spawn: true, reason: 'infra', forced: false }
  return { spawn: false, reason: 'no-path-hit', forced: false }
}

function prioritizeCandidates(candidates: string[], gates: Record<string, Gate>): string[] {
  const score = (agent: string): number => {
    if (agent === 'R-adversarial') return 1_000
    if (agent === 'R-security-auditor') return 100
    if (agent === 'R-architect' && gates[agent].reason.startsWith('axial:')) return 95
    if (agent === 'R-devops') return 80
    if (agent === 'R-tester') return 75
    if (agent === 'R-architect') return 70
    return 0
  }
  // Ties break on manifest order. Five entries — the scan is the table.
  const stableOrder = (agent: string): number => (DISPATCHABLE as readonly string[]).indexOf(agent)
  return [...candidates].sort((a, b) => score(b) - score(a) || stableOrder(a) - stableOrder(b))
}

function applyCap(
  candidates: string[],
  isForced: (agent: string) => boolean,
  max: number,
  knob: string,
  warnings: string[],
): { kept: string[]; capped: string[] } {
  const forced = candidates.filter(isForced)
  const gated = candidates.filter((a) => !isForced(a))
  let cap = max
  if (forced.length > cap) {
    warnings.push(`${knob} (${max}) < forced agents (${forced.length}) — cap raised to ${forced.length}`)
    cap = forced.length
  }
  const room = cap - forced.length
  const keptGated = gated.slice(0, room)
  const capped = gated.slice(room)
  if (capped.length) {
    warnings.push(`roster: ${capped.length} agent(s) dropped by ${knob}: ${capped.join(', ')}`)
  }
  return { kept: [...forced, ...keptGated], capped }
}

export function computeRoster(input: ComputeRosterInput): RosterResult {
  const { delta, tier, chunks, pricedClaimOk, axialAdr, stackPaths, config } = input
  const warnings = [...config.warnings]
  const claims = input.specDraft ? [] : input.claims.filter((c) => Object.hasOwn(VALID_CLAIMS, c))
  const path_hit = pathHit(delta)
  const delta_test_hit = testHit(delta)
  const infra = infraHit(delta)
  const structural = structureHit(delta, stackPaths)

  const gates: Record<string, Gate> = {}

  gates['R-adversarial'] = applyOverride(
    'R-adversarial',
    { spawn: true, reason: 'floor', forced: true },
    config.overrides,
    warnings,
  )

  gates['R-security-auditor'] = applyOverride(
    'R-security-auditor',
    { spawn: path_hit, reason: path_hit ? 'path-hit' : 'no-path-hit', forced: false },
    config.overrides,
    warnings,
  )

  const untested = tier !== 'S' && sourceHit(delta) && !delta_test_hit
  gates['R-tester'] = applyOverride('R-tester', testerGate(delta_test_hit, untested), config.overrides, warnings)

  gates['R-devops'] = applyOverride('R-devops', devopsGate(infra), config.overrides, warnings)

  gates['R-architect'] = applyOverride(
    'R-architect',
    architectGate(axialAdr, delta, structural, config.axialOverride),
    config.overrides,
    warnings,
  )

  const candidates = prioritizeCandidates(
    DISPATCHABLE.filter((a) => gates[a].spawn),
    gates,
  )
  const isForced = (a: string): boolean => gates[a].forced
  const { kept, capped } = applyCap(candidates, isForced, config.maxAgents, 'max_agents', warnings)
  for (const a of capped) {
    gates[a] = { spawn: false, reason: 'capped', forced: false }
  }
  const maxAgents = Math.max(config.maxAgents, candidates.filter(isForced).length)

  const gateRows: GateRow[] = [...DISPATCHABLE, ...PHASE_AGENTS].map((agent) => ({
    agent,
    spawn: gates[agent].spawn,
    reason: gates[agent].reason,
    forced: gates[agent].forced,
  }))

  return {
    tier,
    delta_count: delta.length,
    chunks,
    agents: [...kept],
    candidates: [...candidates],
    gates: gateRows,
    capped,
    path_hit,
    spawn_security_auditor: gates['R-security-auditor'].spawn,
    delta_test_hit,
    claims,
    priced_claim_ok: pricedClaimOk,
    max_agents: maxAgents,
    warnings,
    review_halt: false,
  }
}

function allocationWarnings(globalWarnings: string[], per: RosterResult[]): string[] {
  const warnings = globalWarnings.filter((warning) => !warning.includes('dropped by max_agents:'))
  for (const roster of per) {
    for (const warning of roster.warnings) {
      if (!warning.includes('dropped by max_agents:') && !warnings.includes(warning)) warnings.push(warning)
    }
  }
  return warnings
}

function capChunkReview(
  roster: RosterResult,
  candidates: string[],
  maxAgents: number,
): { agents: string[]; gates: GateRow[]; capped: string[]; warnings: string[] } {
  const warnings: string[] = []
  const forced = (agent: string): boolean => roster.gates.find((row) => row.agent === agent)?.forced ?? false
  const cap = applyCap(candidates, forced, maxAgents, 'max_agents', warnings)
  const dropped = new Set(cap.capped)
  return {
    agents: cap.kept,
    gates: roster.gates.map((row) => ({
      agent: row.agent,
      spawn: cap.kept.includes(row.agent),
      reason: dropped.has(row.agent) ? 'capped' : row.reason,
      forced: row.forced,
    })),
    capped: cap.capped,
    warnings,
  }
}

function capChunkReviewers(
  per: RosterResult[],
  maxAgents: number,
): { agents: string[][]; gates: GateRow[][]; capped: string[]; warnings: string[] } {
  const agents: string[][] = []
  const gates: GateRow[][] = []
  const capped: string[] = []
  const warnings: string[] = []
  for (const roster of per) {
    const chunk = capChunkReview(roster, [...roster.candidates], maxAgents)
    agents.push(chunk.agents)
    gates.push(chunk.gates)
    for (const agent of chunk.capped) {
      if (!capped.includes(agent)) capped.push(agent)
    }
    for (const warning of chunk.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning)
    }
  }
  return { agents, gates, capped, warnings }
}

// Per-chunk gate rows, index-aligned with `chunk_agents`: the reason chunk i
// spawned an agent, and chunk i's own cap verdict. `global.gates` answers the
// same questions for the whole Δ and disagrees by construction (#535 F1).

export function allocateReview(input: AllocateReviewInput): AllocateReviewResult {
  const { chunkDeltas, shared } = input
  const global = computeRoster(shared)
  const per = chunkDeltas.map((delta) => computeRoster({ ...shared, delta }))
  const chunks = capChunkReviewers(per, shared.config.maxAgents)
  const warnings = allocationWarnings(global.warnings, per)
  for (const warning of chunks.warnings) {
    if (!warnings.includes(warning)) warnings.push(warning)
  }

  return {
    global,
    chunk_agents: chunks.agents,
    chunk_gates: chunks.gates,
    capped: chunks.capped,
    warnings,
    agents: DISPATCHABLE.filter((agent) => chunks.agents.some((chunk) => chunk.includes(agent))),
  }
}
