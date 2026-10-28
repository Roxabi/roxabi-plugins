import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeSimCommand, type SimCommandResult } from './sim-execution.ts'
import type { State } from './sim-types.ts'

export function base(extra: Record<string, unknown> = {}) {
  return {
    viewer: 'operator',
    owner: 'acme',
    name: 'app',
    defaultBranch: 'main',
    origin: '',
    requiredChecks: [] as string[],
    nextPr: 10,
    clock: 0,
    issues: {},
    prs: {},
    checks: {},
    events: {},
    calls: [] as string[][],
    ...extra,
  }
}

export function pull(number: number, head: string, sha: string, extra: Record<string, unknown> = {}) {
  return {
    number,
    title: head,
    body: 'original\n',
    state: 'OPEN',
    headRefName: head,
    baseRefName: 'main',
    headRefOid: sha,
    isCrossRepository: false,
    labels: [] as string[],
    autoMerge: null,
    mergeCommit: null,
    mergedAt: null,
    comments: [] as unknown[],
    closes: [] as number[],
    ...extra,
  }
}

export function openState(state: unknown): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'omp-sim-transport-'))
  const file = join(root, 'gh-state.json')
  writeFileSync(file, JSON.stringify(state, null, 2))
  return { root, file }
}

export function saved(file: string): State {
  return JSON.parse(readFileSync(file, 'utf8'))
}

export function run(file: string, argv: string[], cwd: string, stdin?: string): SimCommandResult {
  const previous = process.env.GH_SIM_STATE
  process.env.GH_SIM_STATE = file
  try {
    return executeSimCommand(argv, {
      cwd,
      readStdin() {
        if (stdin === undefined) throw new Error('stdin was not supplied')
        return stdin
      },
    })
  } finally {
    if (previous === undefined) delete process.env.GH_SIM_STATE
    else process.env.GH_SIM_STATE = previous
  }
}

export function dispose(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
