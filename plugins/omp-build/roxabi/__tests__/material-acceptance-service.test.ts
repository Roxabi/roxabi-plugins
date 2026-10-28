import { expect, test } from 'vitest'
import type { OperatorConfirmationEvidence } from '../../engine/uw-identity-schema.ts'
import type { PreparedMaterialAcceptance } from '../../engine/workflow-spec-assessment.ts'
import { createInstalledMaterialAcceptance } from '../material-acceptance-service.ts'
import type { OperatorPort, UwOperationResult } from '../uw-contract.ts'

const UW = { repository: 'acme/widgets', target: 'acme/widgets#42' }
const CONFIRMATION: OperatorConfirmationEvidence = {
  route: 'omp-native-command',
  operationId: 'accept-material-test',
  proposalDigest: 'a'.repeat(64),
  confirmedAt: '2026-10-27T12:00:00.000Z',
}
const PREPARED = {} as PreparedMaterialAcceptance

function operator(): OperatorPort {
  return {
    async executeConfirmed(_proposal, action) {
      return { status: 'confirmed', value: await action(CONFIRMATION) }
    },
  }
}

function acceptance(result: UwOperationResult) {
  return createInstalledMaterialAcceptance(operator(), {
    prepare: async () => ({ ok: true, value: PREPARED }),
    recheck: async () => ({ ok: true }),
    commit: async () => result,
  })
}

test('preserves partial material publication after a durable post-effect read failure', async () => {
  const result = { status: 'partial' as const, uw: UW, diagnostics: [] }

  await expect(acceptance(result)(UW)).resolves.toEqual(result)
})

test('preserves an uncertain material publication rather than converting it to refusal', async () => {
  const result = {
    status: 'uncertain' as const,
    diagnostics: [{ code: 'github-write-uncertain', message: 'Read-back failed' }],
  }

  await expect(acceptance(result)(UW)).resolves.toEqual(result)
})
