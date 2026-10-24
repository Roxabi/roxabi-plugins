import { STACK_YML } from '../../hooks/lib/contract-paths.cjs'
import type { ReviewTier } from './roster-contract'
import { normalizeTier } from './roster-spec'

const TIERS: Record<string, true> = { S: true, 'F-lite': true, 'F-full': true }

export type RosterCliArguments = {
  diffList: string
  chunkLists: string[]
  tier: ReviewTier
  specPath: string | null
  chunks: number
  chunksExplicit: boolean
  stackPath: string
  adrDir: string
  json: boolean
}

function usage(): never {
  console.error(
    'usage: roster.ts --diff-list FILE [--chunk-list FILE ...] [--tier S|F-lite|F-full] [--spec PATH] [--chunks N] [--stack PATH] [--adr-dir PATH] [--json]',
  )
  process.exit(1)
}

function defaults(): RosterCliArguments {
  return {
    diffList: '',
    chunkLists: [],
    tier: 'F-lite',
    specPath: null,
    chunks: 1,
    chunksExplicit: false,
    stackPath: STACK_YML,
    adrDir: 'docs/architecture/adr',
    json: false,
  }
}

function requireValue(args: string[], index: number): string {
  const value = args[index + 1]
  if (value === undefined) usage()
  return value
}
function applyTier(value: string, options: RosterCliArguments): void {
  options.tier = normalizeTier(value)
  if (!Object.hasOwn(TIERS, value.trim())) console.error(`tier ${JSON.stringify(value)} → ${options.tier}`)
}

function applyChunkCount(value: string, options: RosterCliArguments): void {
  if (!/^[1-9]\d*$/.test(value)) usage()
  options.chunks = Number(value)
  options.chunksExplicit = true
}

const VALUE_OPTIONS: Record<string, (value: string, options: RosterCliArguments) => void> = {
  '--diff-list': (value, options) => {
    options.diffList = value
  },
  '--chunk-list': (value, options) => {
    options.chunkLists.push(value)
  },
  '--tier': applyTier,
  '--spec': (value, options) => {
    options.specPath = value
  },
  '--chunks': applyChunkCount,
  '--stack': (value, options) => {
    options.stackPath = value
  },
  '--adr-dir': (value, options) => {
    options.adrDir = value
  },
}

function applyValueOption(argument: string, value: string, options: RosterCliArguments): void {
  const apply = VALUE_OPTIONS[argument]
  if (!apply) usage()
  apply(value, options)
}

export function parseRosterCliArguments(args: string[]): RosterCliArguments {
  const options = defaults()
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--json') {
      options.json = true
      continue
    }
    applyValueOption(argument, requireValue(args, index), options)
    index++
  }
  if (!options.diffList) usage()
  return options
}
