#!/usr/bin/env bun

import { parsePricedFences, specIsDraft } from '../../roxabi/uw-spec'
import { parseRosterCliArguments, type RosterCliArguments } from './roster-cli-arguments'
import { dispatchRosterCli, type RosterCliDispatch } from './roster-cli-dispatch'
import { loadRosterCliInput, type RosterCliInput } from './roster-cli-input'
import { parseRosterConfig, parseStackPaths } from './roster-config'
import type { ComputeRosterInput } from './roster-contract'
import { hasAxialAdr } from './roster-files'

type PreparedRosterInput = {
  shared: ComputeRosterInput
  hasPricedFence: boolean
}

function printResult(result: object, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) || (typeof value === 'object' && value !== null))
      console.log(`${key}=${JSON.stringify(value)}`)
    else console.log(`${key}=${value}`)
  }
}

function specFacts(content: string | null): {
  claims: string[]
  pricedClaimOk: boolean
  hasPricedFence: boolean
  specDraft: boolean
} {
  if (content == null) return { claims: [], pricedClaimOk: true, hasPricedFence: false, specDraft: false }
  const parsed = parsePricedFences(content)
  return { ...parsed, specDraft: specIsDraft(content) }
}

function prepareRosterInput(options: RosterCliArguments, input: RosterCliInput): PreparedRosterInput {
  const spec = specFacts(input.specContent)
  const config = parseRosterConfig(input.stackText)
  config.warnings.push(...input.ioWarnings)
  return {
    hasPricedFence: spec.hasPricedFence,
    shared: {
      delta: input.delta,
      tier: options.tier,
      chunks: input.chunks,
      claims: spec.claims,
      pricedClaimOk: spec.pricedClaimOk,
      specDraft: spec.specDraft,
      axialAdr: hasAxialAdr(options.adrDir, config.warnings),
      stackPaths: parseStackPaths(input.stackText),
      config,
    },
  }
}

function exitForResult(
  options: RosterCliArguments,
  input: RosterCliInput,
  prepared: PreparedRosterInput,
  dispatched: RosterCliDispatch,
): never {
  if (input.specUnreadable) {
    console.error(`roster: unreadable spec: ${options.specPath}`)
    process.exit(1)
  }
  if (prepared.hasPricedFence && !dispatched.pricedClaimOk) {
    console.error('roster: priced fence missing a valid claim')
    process.exit(2)
  }
  process.exit(0)
}

function main(): void {
  const options = parseRosterCliArguments(process.argv.slice(2))
  const input = loadRosterCliInput(options)
  const prepared = prepareRosterInput(options, input)
  const dispatched = dispatchRosterCli({ options, input, shared: prepared.shared })
  printResult(dispatched.result, options.json)
  exitForResult(options, input, prepared, dispatched)
}

if (import.meta.main) main()
