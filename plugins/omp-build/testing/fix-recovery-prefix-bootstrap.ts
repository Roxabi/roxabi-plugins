import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { featureMandate, pullHistory } from './feature-ci-review-fixture.ts'
import type { Box } from './sandbox/sandbox-types.ts'

/** Read the real public baseline before constructing structural external recovery history. */
export function readFixRecoveryPrefixBootstrap(box: Box, cwd: string) {
  const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
  const runner = path.resolve(import.meta.dirname, 'fix-recovery-prefix-reader.ts')
  const read = spawnSync(bun, [runner, cwd], { cwd, env: box.env, encoding: 'utf8', timeout: 55_000 })
  if (read.status !== 0) throw new Error(`fixture-baseline-read-failed:${read.stderr}\n${read.stdout}`)
  const baseline = JSON.parse(read.stdout) as {
    accepted?: string
    observation?: string
    admission?: { framed: boolean; deliverable: boolean }
  }
  if (baseline.accepted !== 'accepted' || baseline.observation !== 'complete' || !baseline.admission)
    throw new Error(`fixture-baseline-incomplete:${read.stdout}`)
  const { record: mandate, history } = featureMandate(box)
  const binding = pullHistory(box).operations.find((item) => item.record?.kind === 'workflow-binding')?.record
  const receipt = history.operations.find((item) => item.record?.kind === 'action-receipt')?.record
  if (binding?.kind !== 'workflow-binding' || receipt?.kind !== 'action-receipt')
    throw new Error('fixture-authority-missing')
  const head = box.sha['feat/42-save']
  if (!head) throw new Error('fixture-head-missing')
  const spec = acceptedActionInputs(mandate, 'correction').manifest.spec
  if (spec.kind !== 'accepted') throw new Error('fixture-effective-spec-missing')
  return { baseline, mandate, binding, receipt, head, spec }
}
