import type { RosterCliArguments } from './roster-cli-arguments'
import { readOrWarn, stackAbsenceWarning } from './roster-files'

export type RosterCliInput = {
  delta: string[]
  chunkDeltas: string[][]
  chunks: number
  stackText: string | null
  specContent: string | null
  specUnreadable: boolean
  ioWarnings: string[]
}

function listFromText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function printReadWarnings(warnings: string[], fallback: string): never {
  if (warnings.length) {
    for (const warning of warnings) console.error(`roster: ${warning}`)
  } else {
    console.error(fallback)
  }
  process.exit(1)
}

function readDiffList(diffList: string, warnings: string[]): string[] {
  const text = readOrWarn(diffList, diffList, warnings)
  if (text == null) printReadWarnings(warnings, 'roster: unreadable --diff-list')
  return listFromText(text)
}

function readChunkDeltas(chunkLists: string[], warnings: string[]): string[][] {
  const chunkDeltas: string[][] = []
  for (const file of chunkLists) {
    const text = readOrWarn(file, file, warnings)
    if (text == null) printReadWarnings(warnings, `roster: unreadable --chunk-list ${file}`)
    const files = listFromText(text)
    if (!files.length) {
      console.error(`roster: empty --chunk-list ${file}`)
      process.exit(1)
    }
    chunkDeltas.push(files)
  }
  return chunkDeltas
}

function resolveChunkCount(options: RosterCliArguments, warnings: string[]): number {
  if (!options.chunkLists.length) return options.chunks
  if (!options.chunksExplicit) return options.chunkLists.length
  if (options.chunks === options.chunkLists.length) return options.chunks
  warnings.push(
    `--chunks ${options.chunks} disagrees with ${options.chunkLists.length} --chunk-list file(s); using ${options.chunkLists.length}`,
  )
  return options.chunkLists.length
}

function addChunkWarnings(delta: string[], chunkDeltas: string[][], warnings: string[]): void {
  const deltaSet: Record<string, true> = Object.create(null)
  for (const path of delta) deltaSet[path] = true
  const seen: Record<string, true> = Object.create(null)
  for (const files of chunkDeltas) {
    for (const path of files) {
      if (!Object.hasOwn(deltaSet, path)) warnings.push(`chunk path not in --diff-list: ${path}`)
      if (Object.hasOwn(seen, path)) warnings.push(`duplicate chunk path: ${path}`)
      else seen[path] = true
    }
  }
  const uncovered = delta.filter((path) => !Object.hasOwn(seen, path))
  if (uncovered.length) {
    const shown = uncovered.slice(0, 5).join(', ')
    const more = uncovered.length > 5 ? ` (+${uncovered.length - 5} more)` : ''
    warnings.push(`${uncovered.length} delta path(s) in no chunk: ${shown}${more}`)
  }
}

function readStack(stackPath: string, warnings: string[]): string | null {
  const stackText = readOrWarn(stackPath, stackPath, warnings)
  if (stackText == null) {
    const absent = stackAbsenceWarning(stackPath)
    if (absent) warnings.push(absent)
  }
  return stackText
}

function readSpec(specPath: string | null, warnings: string[]): Pick<RosterCliInput, 'specContent' | 'specUnreadable'> {
  if (!specPath) return { specContent: null, specUnreadable: false }
  const specContent = readOrWarn(specPath, specPath, warnings)
  return { specContent, specUnreadable: specContent == null }
}

export function loadRosterCliInput(options: RosterCliArguments): RosterCliInput {
  const ioWarnings: string[] = []
  const delta = readDiffList(options.diffList, ioWarnings)
  const chunkDeltas = readChunkDeltas(options.chunkLists, ioWarnings)
  const chunks = resolveChunkCount(options, ioWarnings)
  if (options.chunkLists.length) addChunkWarnings(delta, chunkDeltas, ioWarnings)
  const stackText = readStack(options.stackPath, ioWarnings)
  const spec = readSpec(options.specPath, ioWarnings)
  return { delta, chunkDeltas, chunks, stackText, ioWarnings, ...spec }
}
