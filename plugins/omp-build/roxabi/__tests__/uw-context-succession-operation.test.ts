import { describe, expect, it, vi } from 'vitest'
import { canonicalValueDigest } from '../../engine/canonical-value.ts'
import type { ContextSuccessionProposal } from '../../engine/workflow-context-disposition-schema.ts'
import { fictionalUnavailableEffectViews } from '../../testing/context-effect-review-fixture.ts'
import { executeContextSuccession, executeHostContextSuccession } from '../uw-context-succession-operation.ts'
import type { OperatorPort, UwOperations } from '../uw-contract.ts'

const uw = { repository: 'acme/widgets', target: 'acme/widgets#42' }
const conservedPayload = {
  format: 'omp-build-context-succession-operation-fixture/1',
  negativeRecordId: 'negative-result',
}
const effectViews = fictionalUnavailableEffectViews({
  scope: uw,
  negativeRecordId: 'negative-result',
  payload: conservedPayload,
  reason:
    'Operation fixture human attribution: no named local-file effects identified for this synthetic succession proposal.',
})
const proposal: ContextSuccessionProposal = {
  format: 'omp-build-context-succession/1',
  operationId: 'operation-1',
  controlId: 'selection-1',
  uw,
  predecessor: { scope: uw, kind: 'mandate', recordId: 'old-mandate' },
  successor: { scope: uw, kind: 'mandate', recordId: 'new-mandate' },
  successorPayloadDigest: 'd'.repeat(64),
  predecessorConfig: { productVersion: '1.0.0', version: 'config-1', digest: '1'.repeat(64), effective: {} },
  successorConfig: { productVersion: '1.1.0', version: 'config-2', digest: '2'.repeat(64), effective: {} },
  negative: effectViews.negative,
  replacementAccepted: {
    uw,
    version: 'b'.repeat(64),
    sourceAccepted: { scope: uw, kind: 'mandate', recordId: 'old-mandate' },
  },
  reconciliation: {
    kind: 'unchanged-delivery-baseline',
    scope: 'workflow-owned-delivery-state',
    code: {
      repository: uw.repository,
      base: 'a'.repeat(40),
      head: 'c'.repeat(40),
      referenceCommit: 'a'.repeat(40),
    },
    repository: uw.repository,
    branch: 'feature/example',
    status: { code: 0, stdout: '' },
    remote: {
      base: { ref: 'main', tip: 'a'.repeat(40) },
      candidate: { ref: 'feature/example', tip: null },
    },
    delivery: { uw, pullRequests: [], integrations: [], commits: [] },
    cuts: [{ scope: uw, count: 0, last: null }],
    historyDigest: 'f'.repeat(64),
    bindingDigest: 'a'.repeat(64),
    effectReview: effectViews.effectReview,
  },
}
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
    effectReports: effectViews.effectReports,
    validateBeforeMandate: vi.fn(async () => true),
    validateBeforeSelection: vi.fn(async () => true),
    publishMandate: vi.fn(async () => true),
    publishSelection: vi.fn(async () => true),
  }
}

describe('confirmed context succession publication', () => {
  it('fails closed when no host operator is bound to the service', async () => {
    const dependencies = ports()
    const { operator: _operator, ...hostPorts } = dependencies
    const result = await executeHostContextSuccession({} as UwOperations, proposal, hostPorts)
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
