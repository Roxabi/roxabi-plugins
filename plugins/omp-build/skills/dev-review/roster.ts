#!/usr/bin/env bun

import { parseRosterCliArguments, type RosterCliArguments } from './roster-cli-arguments'
import { dispatchRosterCli } from './roster-cli-dispatch'
import { loadRosterCliInput, type RosterCliInput } from './roster-cli-input'
import { parseRosterConfig, parseStackPaths } from './roster-config'
import type { ComputeRosterInput } from './roster-contract'
import { hasAxialAdr } from './roster-files'

type PreparedRosterInput = {
  shared: ComputeRosterInput
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

function prepareRosterInput(options: RosterCliArguments, input: RosterCliInput): PreparedRosterInput {
  const config = parseRosterConfig(input.stackText)
  config.warnings.push(...input.ioWarnings)
  return {
    shared: {
      delta: input.delta,
      tier: options.tier,
      chunks: input.chunks,
      axialAdr: hasAxialAdr(options.adrDir, config.warnings),
      stackPaths: parseStackPaths(input.stackText),
      config,
    },
  }
}

function main(): void {
  const options = parseRosterCliArguments(process.argv.slice(2))
  const input = loadRosterCliInput(options)
  const prepared = prepareRosterInput(options, input)
  const dispatched = dispatchRosterCli({ options, input, shared: prepared.shared })
  printResult(dispatched.result, options.json)
}

if (import.meta.main) main()
