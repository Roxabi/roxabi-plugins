import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { validateRecordGraph } from '../../dist/contracts.js'
import { canonicalValueDigest } from '../../engine/action-input.ts'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { accounted } from '../../engine/review-context-authentication.ts'
import { originalContributionAction } from '../../engine/review-original-action.ts'
import { createSuccessorFixture } from '../../testing/ci-attribution-provenance-successor-fixture.ts'
import { pullHistory } from '../../testing/feature-ci-review-fixture.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const roots = new Set<string>()
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots.clear()
})

function assertCompletedIntake(history: DecodedHistory, requestId: string, inputs: ActionInputs) {
  expect(validateRecordGraph(history).ok).toBe(true)
  const inventory = history.operations.find((operation) => {
    const record = operation.record
    return (
      record?.kind === 'review-attempt' &&
      record.payload.purpose === 'correction' &&
      record.payload.stage === 'initial' &&
      record.payload.requestId === requestId
    )
  })?.record
  if (inventory?.kind !== 'review-attempt') throw new Error('successor-intake-inventory-missing')
  expect(accounted(history, inventory)).toBe(true)
  const slot = inventory.payload.slots.find((item) => item.phase === 'intake')
  if (!slot?.action) throw new Error('successor-intake-slot-missing')
  expect(slot.action.inputs).toEqual(inputs)
  const contribution = history.operations.find((operation) => {
    const record = operation.record
    return (
      record?.kind === 'contribution' &&
      record.payload.content === 'findings' &&
      record.payload.inventoryId === inventory.recordId
    )
  })?.record
  if (contribution?.kind !== 'contribution') throw new Error('successor-intake-contribution-missing')
  expect(accounted(history, contribution)).toBe(true)
  expect(contribution.payload.host).toMatchObject({
    origin: 'native',
    phase: 'intake',
    slotId: slot.slotId,
  })
  expect(contribution.payload.native).toMatchObject({ completion: 'completed', strict: 'valid' })
  expect(
    contribution.payload.rawAttempts.some(
      (attempt) =>
        attempt.data !== null &&
        canonicalValueDigest(attempt.data) === canonicalValueDigest(contribution.payload.structured),
    ),
  ).toBe(true)
  expect(originalContributionAction(contribution, history)).toEqual({ ok: true, value: inputs })
  expect(slot.action.inputs.stageSources).toEqual(inputs.stageSources)
}

it('reattributes and completes native intake under the successor mandate', async () => {
  const { box, cwd, pin, control, prefixPath, old } = await createSuccessorFixture(roots)
  writeFileSync(control, JSON.stringify({ shared: pin.candidate }))
  const successorPath = path.resolve(import.meta.dirname, '../../testing/ci-attribution-provenance-successor-runner.ts')
  const successor = spawnSync(BUN, [successorPath, cwd], { cwd, env: box.env, encoding: 'utf8', timeout: 55_000 })
  expect(successor.status, `${successor.stderr}\n${successor.stdout}`).toBe(0)
  writeFileSync(control, '{}')
  const fresh = spawnSync(BUN, [prefixPath, cwd, 'capture-intake'], {
    cwd,
    env: box.env,
    encoding: 'utf8',
    timeout: 55_000,
  })
  expect(fresh.status, `${fresh.stderr}\n${fresh.stdout}`).toBe(0)
  expect(fresh.stdout).not.toContain('fix-open-request-ambiguous')
  const freshOutput = JSON.parse(fresh.stdout) as { attribution: ActionInputs; intake: ActionInputs }
  const latest = pullHistory(box)
  const freshReceipt = latest.operations.find(
    (operation) =>
      operation.record?.kind === 'action-receipt' &&
      operation.record.payload.action === 'attribute-ci' &&
      operation.record.payload.phase === 'result' &&
      operation.record.recordId !== old.recordId,
  )?.record
  if (
    freshReceipt?.kind !== 'action-receipt' ||
    freshReceipt.payload.action !== 'attribute-ci' ||
    freshReceipt.payload.phase !== 'result'
  )
    throw new Error('successor-attribution-missing')
  expect(freshReceipt.payload.mandate.recordId).not.toBe(old.payload.mandate.recordId)
  const oldSubject = old.payload.inputs.manifest.subject
  const freshSubject = freshReceipt.payload.inputs.manifest.subject
  if (oldSubject.kind !== 'uw' || !oldSubject.binding || freshSubject.kind !== 'uw' || !freshSubject.binding)
    throw new Error('successor-binding-missing')
  expect(freshSubject.binding).not.toEqual(oldSubject.binding)
  const successorBinding = latest.operations.find(
    (operation) =>
      operation.record?.kind === 'workflow-binding' &&
      operation.record.recordId === freshSubject.binding?.record.recordId,
  )?.record
  if (successorBinding?.kind !== 'workflow-binding') throw new Error('successor-binding-record-missing')
  expect(accounted(latest, freshReceipt)).toBe(true)
  expect(accounted(latest, successorBinding)).toBe(true)
  expect(successorBinding.payload.mandate).toEqual(freshReceipt.payload.mandate)
  const fixRequest = latest.operations.find((operation) => operation.record?.kind === 'fix-request')?.record
  if (fixRequest?.kind !== 'fix-request') throw new Error('successor-fix-request-missing')
  assertCompletedIntake(latest, fixRequest.recordId, freshOutput.intake)
  const root = latest.operations.find(
    (operation) => operation.recordId === fixRequest.payload.requestContributionId,
  )?.record
  if (root?.kind !== 'contribution') throw new Error('successor-fix-root-missing')
  expect(root.payload.rawAttempts[0]?.raw).toMatchObject({
    operatorRequest: { ciCorrection: { attributionRecordId: freshReceipt.recordId } },
  })
  expect(freshOutput.attribution.manifest.plugin.commit).toBe(pin.candidate)
  expect(freshReceipt.payload.inputs.manifest.plugin.commit).toBe(pin.candidate)
  expect(freshOutput.intake.manifest.plugin.commit).toBe(pin.candidate)
  expect(freshOutput.intake.stageSources.map((ref) => ref.record.recordId)).toEqual([freshReceipt.recordId])
  expect(freshOutput.intake.stageSources[0]?.digest).toBe(canonicalValueDigest(freshReceipt.payload))
})
