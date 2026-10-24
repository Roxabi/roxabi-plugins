export const VALID_CLAIMS: Record<string, true> = { 'fail-closed': true, authz: true, ssot: true }

export type ReviewTier = 'S' | 'F-lite' | 'F-full'
export type AgentOverride = 'default' | 'always' | 'never'

export type StackPaths = {
  frontendPath: string
  sharedUi: string
  backendPath: string
  sharedRoots?: string[]
  adrPath?: string
}

export type RosterConfig = {
  maxAgents: number
  axialOverride: AgentOverride
  overrides: Record<string, AgentOverride>
  warnings: string[]
}

export type GateRow = {
  agent: string
  spawn: boolean
  reason: string
  /** Operator-pinned (`floor`, `agents: <role>: always`, `axial: always`). A
   *  property, ¬a spelling of `reason`: the cap reads this, and a reason that
   *  also carries a mode prefix (`axial:stack:always`) must still bypass it. */
  forced: boolean
}

export type RosterResult = {
  tier: ReviewTier
  delta_count: number
  chunks: number
  agents: string[]
  candidates: string[]
  gates: GateRow[]
  capped: string[]
  path_hit: boolean
  spawn_security_auditor: boolean
  delta_test_hit: boolean
  claims: string[]
  priced_claim_ok: boolean
  max_agents: number
  warnings: string[]
  review_halt: boolean
}

export type ComputeRosterInput = {
  delta: string[]
  tier: ReviewTier
  chunks: number
  claims: string[]
  pricedClaimOk: boolean
  specDraft: boolean
  axialAdr: boolean
  stackPaths: StackPaths
  config: RosterConfig
}

export const DISPATCHABLE = ['R-adversarial', 'R-security-auditor', 'R-architect', 'R-devops', 'R-tester'] as const

export const PHASE_AGENTS = [] as const

export type AllocateReviewInput = {
  chunkDeltas: string[][]
  shared: Omit<ComputeRosterInput, 'delta'> & { delta: string[] }
}

export type AllocateReviewResult = {
  /** Review-wide roster over the full Δ: signals (`path_hit`, `claims`, …) and
   *  the review-wide gate rows. It is **not** the dispatch source — see
   *  `chunk_gates`. */
  global: RosterResult
  chunk_agents: string[][]
  /** Per-chunk gate rows, index-aligned with `chunk_agents`. The dispatch source:
   *  a chunk's spawn reason (axial vs structure) and its cap verdict are chunk
   *  facts, and reading them off `global` sets AXIAL MODE on chunks whose own
   *  gate said `structure`. */
  chunk_gates: GateRow[][]
  capped: string[]
  warnings: string[]
  agents: string[]
}
