import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { fictionalUnavailableEffectViews } from '../../testing/context-effect-review-fixture.ts'
import { operatorDialogUi, operatorRootContext } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { createOperatorConfirmation } from '../omp-operator-confirmation.ts'

describe('context succession operator confirmation', () => {
  it('shows the bounded succession decision and never executes a declined handoff', async () => {
    const uw = { repository: 'acme/widgets', target: 'acme/widgets#42' }
    const protocol = consultableProtocolOptions()
    const root = operatorRootContext('/repo/feature', protocol)
    const conservedPayload = {
      format: 'omp-build-context-succession-ui-fixture/1',
      negativeRecordId: 'negative-result',
    }
    const effectViews = fictionalUnavailableEffectViews({
      scope: uw,
      negativeRecordId: 'negative-result',
      payload: conservedPayload,
      namespace: {
        kind: 'confirmation-local-observer',
        id: 'fixture-ui-observer',
        sessionId: root.sessionManager.getSessionId(),
        agentId: root.agent.id,
      },
      reason:
        'UI fixture human attribution: no named local-file effects identified for this synthetic succession confirmation.',
    })
    const prepared = {
      digest: 'a'.repeat(64),
      proposal: {
        format: 'omp-build-context-succession/1' as const,
        operationId: 'succession-1',
        controlId: 'selection-1',
        uw,
        predecessor: { scope: uw, kind: 'mandate' as const, recordId: 'old-mandate' },
        successor: { scope: uw, kind: 'mandate' as const, recordId: 'new-mandate' },
        successorPayloadDigest: 'd'.repeat(64),
        predecessorConfig: { productVersion: '1.0.0', version: 'config-1', digest: '1'.repeat(64), effective: {} },
        successorConfig: { productVersion: '1.1.0', version: 'config-2', digest: '2'.repeat(64), effective: {} },
        negative: effectViews.negative,
        replacementAccepted: {
          uw,
          version: 'b'.repeat(64),
          sourceAccepted: { scope: uw, kind: 'mandate' as const, recordId: 'old-mandate' },
        },
        reconciliation: {
          kind: 'unchanged-delivery-baseline' as const,
          scope: 'workflow-owned-delivery-state' as const,
          code: {
            repository: uw.repository,
            base: 'a'.repeat(40),
            head: 'c'.repeat(40),
            referenceCommit: 'a'.repeat(40),
          },
          repository: uw.repository,
          branch: 'feature/example',
          status: { code: 0 as const, stdout: '' as const },
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
      },
      effectReports: effectViews.effectReports,
    }
    let displayed = ''
    let executed = false
    const context = {
      ...root,
      hasUI: true,
      mode: 'tui',
      localProtocolOptions: protocol,
      ui: operatorDialogUi(
        async () => 'refuse',
        (message) => {
          displayed = message
        },
      ),
    } as unknown as ExtensionContext
    const result = await createOperatorConfirmation(context).executeConfirmed(prepared, async () => {
      executed = true
    })
    expect(result.status).toBe('refused')
    expect(executed).toBe(false)
    for (const fact of ['old-mandate', 'new-mandate', 'negative-result', 'fixture-ui-observer']) {
      expect(displayed).toContain(fact)
    }
  })
})
