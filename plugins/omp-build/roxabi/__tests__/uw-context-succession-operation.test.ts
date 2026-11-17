import { describe, expect, it, vi } from 'vitest'
import { canonicalValueDigest } from '../../engine/canonical-value.ts'
import type { ContextSuccessionProposal } from '../../engine/workflow-context-disposition-schema.ts'
import { executeContextSuccession, executeHostContextSuccession } from '../uw-context-succession-operation.ts'
import type { OperatorPort, UwOperations } from '../uw-contract.ts'

const proposal = { format: 'omp-build-context-succession/1', operationId: 'operation-1' } as ContextSuccessionProposal
const confirmed: OperatorPort = {
  async executeConfirmed(prepared, action) {
    return {
      status: 'confirmed',
      value: await action({
        route: 'omp-native-command',
        operationId: proposal.operationId,
        proposalDigest: prepared.digest,
        confirmedAt: '2025-01-01T00:00:00.000Z',
      }),
    }
  },
}

function ports(operator: OperatorPort = confirmed) {
  return {
    operator,
    validateBeforeMandate: vi.fn(async () => true),
    validateBeforeSelection: vi.fn(async () => true),
    publishMandate: vi.fn(async () => true),
    publishSelection: vi.fn(async () => true),
  }
}

describe('confirmed context succession publication', () => {
  it('fails closed when no host operator is bound to the service', async () => {
    const dependencies = ports()
    const result = await executeHostContextSuccession({} as UwOperations, proposal, dependencies)
    expect(result.status).toBe('refused')
    expect(dependencies.publishMandate).not.toHaveBeenCalled()
  })

  it('never publishes if the operator declines', async () => {
    const dependencies = ports({
      async executeConfirmed() {
        return { status: 'refused', diagnostics: [] }
      },
    })
    const result = await executeContextSuccession(proposal, dependencies)
    expect(result.status).toBe('refused')
    expect(dependencies.publishMandate).not.toHaveBeenCalled()
    expect(dependencies.publishSelection).not.toHaveBeenCalled()
  })

  it('reports partial publication and does not select when freshness changes after mandate publication', async () => {
    const dependencies = ports()
    dependencies.validateBeforeSelection.mockResolvedValueOnce(false)
    const result = await executeContextSuccession(proposal, dependencies)
    expect(result.status).toBe('partial')
    expect(dependencies.publishMandate).toHaveBeenCalledOnce()
    expect(dependencies.publishSelection).not.toHaveBeenCalled()
  })

  it('rejects mismatched confirmation evidence before publication', async () => {
    const dependencies = ports({
      async executeConfirmed(_prepared, action) {
        return {
          status: 'confirmed',
          value: await action({
            route: 'omp-native-command',
            operationId: proposal.operationId,
            proposalDigest: canonicalValueDigest({ other: true }),
            confirmedAt: '2025-01-01T00:00:00.000Z',
          }),
        }
      },
    })
    expect((await executeContextSuccession(proposal, dependencies)).status).toBe('refused')
    expect(dependencies.publishMandate).not.toHaveBeenCalled()
  })

  it('does not publish when validation is unavailable', async () => {
    const dependencies = ports()
    dependencies.validateBeforeMandate.mockRejectedValueOnce(new Error('validator unavailable'))
    expect((await executeContextSuccession(proposal, dependencies)).status).toBe('refused')
    expect(dependencies.publishMandate).not.toHaveBeenCalled()
    expect(dependencies.publishSelection).not.toHaveBeenCalled()
  })

  it('passes the confirmed evidence only after both observations', async () => {
    const dependencies = ports()
    const result = await executeContextSuccession(proposal, dependencies)
    expect(result.status).toBe('published')
    expect(dependencies.validateBeforeMandate).toHaveBeenCalledOnce()
    expect(dependencies.validateBeforeSelection).toHaveBeenCalledOnce()
    expect(dependencies.publishSelection).toHaveBeenCalledWith(
      proposal,
      expect.objectContaining({
        operationId: proposal.operationId,
        proposalDigest: canonicalValueDigest(proposal),
      }),
    )
  })
})
