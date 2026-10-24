import { spawnSync } from 'node:child_process'
import { readSim, WORKFLOW } from '../../__fixtures__/proof/sandbox-repository'
import type { Box } from '../../__fixtures__/proof/sandbox-types'
import type { Land, LandRun } from './data'
import { GAP, REAL_BUN } from './environment'
import { producerCalls } from './setup'

/** The real `landPr`, forked under bun, and what it did to the simulated PR. */
export function land(box: Box, cwd: string, pr: number, mode?: 'native' | 'merge-on-green'): LandRun {
  const before = readSim(box).calls.length
  const payload = { pr, ...(mode && { landing: { mode, required_checks: ['ci'] } }) }
  const out = spawnSync(REAL_BUN, [WORKFLOW, 'landPr', cwd, JSON.stringify(payload)], {
    cwd,
    env: box.env,
    encoding: 'utf8',
  })
  if (out.status !== 0) throw new Error(`landPr exited ${out.status}: ${out.stderr}`)
  const state = readSim(box)
  const pull = state.prs[String(pr)]
  const result: Land = JSON.parse(out.stdout)
  return {
    result,
    calls: state.calls.slice(before),
    gate: { labels: pull?.labels, autoMerge: pull?.autoMerge ?? null },
    producers: producerCalls(box),
  }
}

export const UNARMED = { labels: [], autoMerge: null }
export const noTest = (reason: string): string =>
  `Closes #1\n\n| Gap | Why | Proof |\n|---|---|---|\n| \`${GAP}\` | finite inputs | ⚠ NO TEST — ${reason} |\n`
export const browser = ({
  heading = `\`${GAP}\``,
  steps = 'open the calculator, add 1 and Infinity',
  url = 'http://localhost:3000/add',
  observed = 'RangeError shown',
}: {
  heading?: string
  steps?: string
  url?: string
  observed?: string
} = {}): string =>
  `${noTest('ui-manual-only')}\n### Browser check ${heading}\n- Steps: ${steps}\n- URL: ${url}\n- Observed: ${observed}\n`
