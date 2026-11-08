import type { RosterCliArguments } from './roster-cli-arguments'
import type { RosterCliInput } from './roster-cli-input'
import type { ComputeRosterInput } from './roster-contract'
import { allocateReview, computeRoster } from './roster-selection'

export type RosterCliDispatch = {
  result: object
}

type DispatchInput = {
  options: RosterCliArguments
  input: RosterCliInput
  shared: ComputeRosterInput
}

function dispatchChunks({ input, shared }: DispatchInput): RosterCliDispatch {
  const allocated = allocateReview({ chunkDeltas: input.chunkDeltas, shared })
  return {
    result: {
      ...allocated.global,
      chunk_agents: allocated.chunk_agents,
      chunk_gates: allocated.chunk_gates,
      capped: allocated.capped,
      agents: allocated.agents,
      warnings: allocated.warnings,
    },
  }
}

function dispatchSingle({ shared }: DispatchInput): RosterCliDispatch {
  return { result: computeRoster(shared) }
}

export function dispatchRosterCli(input: DispatchInput): RosterCliDispatch {
  if (input.options.chunkLists.length) return dispatchChunks(input)
  return dispatchSingle(input)
}
