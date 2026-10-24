import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach } from 'vitest'
import type { AgentOverride, ComputeRosterInput, RosterConfig, StackPaths } from '../roster-contract'
import { computeRoster } from '../roster-selection'

export const ROSTER = fileURLToPath(new URL('../roster.ts', import.meta.url))
export const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0
export let dir = ''

export function useRosterWorkspace(): void {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roster-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })
}

export function writeSpec(body: string): string {
  const p = join(dir, 'spec.md')
  writeFileSync(
    p,
    `---
title: test
status: approved
---

## Success Criteria

${body}
`,
  )
  return p
}

export function defaultConfig(overrides: Partial<RosterConfig> = {}): RosterConfig {
  return { maxAgents: 3, axialOverride: 'default', overrides: {}, warnings: [], ...overrides }
}

export function emptyPaths(): StackPaths {
  return { frontendPath: '', sharedUi: '', backendPath: '' }
}

export function roster(partial: Partial<ComputeRosterInput> = {}) {
  return computeRoster({
    delta: ['src/foo.ts'],
    tier: 'F-lite',
    chunks: 1,
    claims: [],
    pricedClaimOk: true,
    specDraft: false,
    axialAdr: false,
    stackPaths: emptyPaths(),
    config: defaultConfig(),
    ...partial,
  })
}

export function gate(out: ReturnType<typeof computeRoster>, agent: string) {
  return out.gates.find((g) => g.agent === agent)
}
export type { AgentOverride, ComputeRosterInput, RosterConfig, StackPaths }
