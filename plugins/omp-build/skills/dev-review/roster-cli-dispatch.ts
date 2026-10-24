import type { RosterCliArguments } from './roster-cli-arguments'
import type { RosterCliInput } from './roster-cli-input'
import type { ComputeRosterInput } from './roster-contract'
import { allocateReview, computeRoster } from './roster-selection'

export type RosterCliDispatch = {
  result: object
  pricedClaimOk: boolean
}

type DispatchInput = {
  options: RosterCliArguments
  input: RosterCliInput
  shared: ComputeRosterInput
}

function haltForUnreadableSpec<T extends { review_halt: boolean; warnings: string[] }>(
  result: T,
  specPath: string | null,
): T {
  if (specPath != null) {
    result.review_halt = true
    result.warnings.push(`unreadable spec: ${specPath}`)
  }
  return result
}

function dispatchChunks({ options, input, shared }: DispatchInput): RosterCliDispatch {
  const allocated = allocateReview({ chunkDeltas: input.chunkDeltas, shared })
  if (input.specUnreadable) {
    allocated.global.review_halt = true
    allocated.warnings.push(`unreadable spec: ${options.specPath}`)
  }
  return {
    result: {
      ...allocated.global,
      chunk_agents: allocated.chunk_agents,
      chunk_gates: allocated.chunk_gates,
      capped: allocated.capped,
      agents: allocated.agents,
      warnings: allocated.warnings,
    },
    pricedClaimOk: allocated.global.priced_claim_ok,
  }
}

function dispatchSingle({ options, input, shared }: DispatchInput): RosterCliDispatch {
  const result = computeRoster(shared)
  if (input.specUnreadable) haltForUnreadableSpec(result, options.specPath)
  return { result, pricedClaimOk: result.priced_claim_ok }
}

export function dispatchRosterCli(input: DispatchInput): RosterCliDispatch {
  if (input.options.chunkLists.length) return dispatchChunks(input)
  return dispatchSingle(input)
}
