import { expect, test } from 'vitest'
import {
  mandateAssessmentState,
  proposedAssessmentState,
} from '../engine/__tests__/workflow-spec-assessment-support.ts'
import { failedCheckEvidenceDigest } from '../engine/record-digests.ts'
import { mechanicalSpecDelta } from '../engine/workflow-spec-assessment.ts'
import { standaloneReviewInputs } from '../testing/action-input-fixtures.ts'
import { shippedMandate } from '../testing/workflow-decision-cases/support/workflow-decision-fixtures.ts'
import { sealReceipt } from './feature-action-receipt.ts'
import { dossierIndex, materializeActionFiles } from './uw-action-dossier.ts'

const scope = { repository: 'acme/app', target: 'acme/app#42' }
const candidateGitSHA = 'a'.repeat(40)
const failures = [
  { name: 'test', source: 'github-check-run' as const, observationId: 'check-1', conclusion: 'failure' },
]
const evidenceDigest = failedCheckEvidenceDigest({ candidateGitSHA, scope, failures })
if (evidenceDigest === null) throw new Error('expected a check evidence digest')
const operands = {
  action: 'attribute-ci' as const,
  exactInputs: { candidateGitSHA, scope, failedChecks: ['test'], failures, evidenceDigest },
}

test('dossier materializes and indexes the exact manifest operands', async () => {
  const manifest = { ...standaloneReviewInputs().manifest, purpose: 'attribute-ci' as const, operands }
  const ports = {
    readCodeDiff: async () => ({ ok: true as const, value: Buffer.from('diff') }),
    readRecords: async (refs: readonly unknown[]) => ({ ok: true as const, value: refs.map(() => ({})) }),
    readPinnedFile: async () => {
      throw new Error('unexpected pinned file read')
    },
  }
  const result = await materializeActionFiles(ports, manifest, [])
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const file = result.value.find((entry) => entry.path === 'action/exact-inputs.json')
  expect(file).toBeDefined()
  if (file === undefined) throw new Error('expected exact inputs file')
  expect(JSON.parse(Buffer.from(file.bytes).toString('utf8'))).toEqual(operands.exactInputs)
  const index = Buffer.from(dossierIndex(manifest, result.value)).toString('utf8')
  expect(index).toContain('CI failures: action/exact-inputs.json')
  expect(index).toContain('- action/exact-inputs.json')
})

test('assessment dossier distinguishes accepted and proposed exact states', async () => {
  const mandate = shippedMandate()
  if (mandate.kind !== 'mandate') throw new Error('expected mandate')
  const accepted = mandateAssessmentState(mandate)
  const proposed = proposedAssessmentState(accepted, { body: 'Changed proposal' })
  const exactInputs = {
    format: 'omp-build-spec-assessment/2' as const,
    accepted,
    proposed,
    identityAllocations: mandate.payload.ownSpec.identityAllocations,
    mechanical: mechanicalSpecDelta(accepted, proposed),
  }
  const manifest = {
    ...standaloneReviewInputs().manifest,
    purpose: 'assess-spec' as const,
    operands: { action: 'assess-spec' as const, exactInputs },
  }
  const ports = {
    readCodeDiff: async () => ({ ok: true as const, value: Buffer.from('diff') }),
    readRecords: async (refs: readonly unknown[]) => ({ ok: true as const, value: refs.map(() => ({})) }),
    readPinnedFile: async () => {
      throw new Error('unexpected pinned file read')
    },
  }
  const result = await materializeActionFiles(ports, manifest, [])
  expect(result.ok).toBe(true)
  if (!result.ok) return
  const file = result.value.find((entry) => entry.path === 'action/exact-inputs.json')
  if (file === undefined) throw new Error('expected exact inputs file')
  expect(JSON.parse(Buffer.from(file.bytes).toString('utf8'))).toEqual(exactInputs)
  expect(Buffer.from(dossierIndex(manifest, result.value)).toString('utf8')).toContain(
    'Accepted state and proposed state: action/exact-inputs.json',
  )
})

test('sealing refuses changed or missing manifest operands before publication', async () => {
  const inputs = standaloneReviewInputs()
  for (const manifestOperands of [
    undefined,
    { ...operands, exactInputs: { ...operands.exactInputs, candidateGitSHA: 'b'.repeat(40) } },
  ]) {
    const input = {
      action: 'attribute-ci',
      exactInputs: operands.exactInputs,
      prepared: { inputs: { ...inputs, manifest: { ...inputs.manifest, operands: manifestOperands } } },
    } as Parameters<typeof sealReceipt>[0]
    expect(await sealReceipt(input)).toMatchObject({ kind: 'blocked', reason: 'action-input-changed' })
  }
})
