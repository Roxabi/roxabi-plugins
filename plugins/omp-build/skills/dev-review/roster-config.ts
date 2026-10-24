import { createRosterDefaults, parseRosterConfigText } from './roster-config-parser'
import type { RosterConfig, StackPaths } from './roster-contract'
import { blockEnd, parseYamlLines } from './roster-yaml'

export function parseRosterConfig(text: string | null): RosterConfig {
  const defaults = createRosterDefaults()
  if (text == null || !text.trim()) return defaults

  try {
    return parseRosterConfigText(text, defaults)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      ...defaults,
      warnings: [`review.roster parse failed: ${message}; using defaults`],
    }
  }
}

export function parseStackPaths(text: string | null): StackPaths {
  if (text == null || !text.trim()) {
    return { frontendPath: '', sharedUi: '', backendPath: '', sharedRoots: [], adrPath: '' }
  }
  const lines = parseYamlLines(text)
  const childScalar = (blockKey: string, childKey: string): string => {
    const idx = lines.findIndex((l) => l.indent === 0 && l.key === blockKey)
    if (idx < 0) return ''
    const end = blockEnd(lines, idx)
    for (let i = idx + 1; i < end; i++) {
      if (lines[i].indent > 0 && lines[i].key === childKey) return lines[i].value
    }
    return ''
  }
  const blockValues = (blockKey: string): string[] => {
    const idx = lines.findIndex((l) => l.indent === 0 && l.key === blockKey)
    if (idx < 0) return []
    const end = blockEnd(lines, idx)
    const values: string[] = []
    for (let i = idx + 1; i < end; i++) {
      if (lines[i].indent > 0 && lines[i].value) values.push(lines[i].value)
    }
    return values
  }
  return {
    frontendPath: childScalar('frontend', 'path'),
    sharedUi: childScalar('shared', 'ui'),
    backendPath: childScalar('backend', 'path'),
    sharedRoots: blockValues('shared'),
    adrPath: childScalar('docs', 'adr_path'),
  }
}
