import { safeOperatorError } from '../omp/omp-operator-confirmation-field.ts'
import { mandatesInHistory } from './feature-context.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import { bindsOwnPause } from './feature-control.ts'
import { configPinDigest, effectiveWorkflowConfig } from './workflow-config-digest.ts'
import { WORKFLOW_CONFIG_VERSION } from './workflow-graph.ts'
import { additionalRequirementsOf } from './workflow-overrides.ts'

/** Resolve one exact interrupted START without changing session ownership or resuming the workflow. */
export async function resolveFeatureInterruption(
  input: ContinueFeatureInput,
  authority: FeatureAuthority,
): Promise<ContinueFeatureResult> {
  const { context, history, scope, selection, causal } = authority
  const mandate = interruptionMandate(authority)
  if (mandate === null) return { kind: 'blocked', reason: 'interruption-not-paused' }
  const runtime = () => {
    const productVersion = context.engine.shippedProductVersion()
    return {
      productVersion,
      configVersion: WORKFLOW_CONFIG_VERSION,
      configDigest: configPinDigest(
        effectiveWorkflowConfig(productVersion, additionalRequirementsOf(mandate.payload.config.effective)),
      ),
    }
  }
  const configMatches = () => {
    const current = runtime()
    const pinned = mandate.payload.config
    return (
      current.productVersion === pinned.productVersion &&
      current.configVersion === pinned.version &&
      current.configDigest === pinned.digest
    )
  }
  try {
    if (!configMatches()) return { kind: 'blocked', reason: 'config-drift' }
    if (!bindsOwnPause(context.engine, selection, history, scope))
      return { kind: 'blocked', reason: 'interruption-not-paused' }
    const attempts = context.engine.resolvableStarts(causal.histories, mandate)
    if (!attempts.ok) return { kind: 'blocked', reason: 'interruption-invalid', diagnostics: attempts.diagnostics }
    const matches =
      input.interruption?.start === undefined
        ? attempts.value
        : attempts.value.filter((item) => item.start.recordId === input.interruption?.start)
    if (matches.length === 0) return { kind: 'blocked', reason: 'interruption-target-none' }
    if (matches.length !== 1) return { kind: 'blocked', reason: 'interruption-target-ambiguous' }
    const selected = matches[0]
    if (!selected) return { kind: 'blocked', reason: 'interruption-target-none' }
    const uw = input.uw
    if (uw === undefined) return { kind: 'blocked', reason: 'interruption-operation-unavailable' }
    const start = {
      scope: { repository: selected.start.repository, target: selected.start.target },
      recordId: selected.start.recordId,
      kind: 'action-receipt' as const,
    }
    const mandateRef = { scope, recordId: mandate.recordId, kind: 'mandate' as const }
    const result = await uw.resolveInterruption({
      mandate: mandateRef,
      start,
      async observe() {
        const failure = (code: string) => ({
          ok: false as const,
          diagnostics: [{ code, message: code, location: { kind: 'record' as const, ref: start }, related: [] }],
        })
        if (!configMatches()) return failure('config-drift')
        return { ok: true as const, value: { runtime: runtime() } }
      },
    })
    return presentInterruptionResult(result)
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `interruption-error: ${safeOperatorError(error instanceof Error ? error.message : String(error))}`,
    }
  }
}

function interruptionMandate({ selection, history }: FeatureAuthority) {
  return selection.status === 'applicable'
    ? selection.mandate
    : selection.reason === 'paused'
      ? (mandatesInHistory(history).find((item) => item.recordId === selection.pause.mandate.recordId) ?? null)
      : null
}

function presentInterruptionResult(
  result: Awaited<ReturnType<NonNullable<ContinueFeatureInput['uw']>['resolveInterruption']>>,
): ContinueFeatureResult {
  if (result.status === 'resolved') return { kind: 'paused', confirmed: true, reason: 'interruption-resolved' }
  if (result.status === 'deferred')
    return {
      kind: 'blocked',
      reason: 'operator-confirmation-deferred',
      diagnostics: [{ code: 'uw-deferred', message: 'Confirmation deferred' }],
    }
  const diagnostics = result.diagnostics.map((item) => ({
    code: safeOperatorError(item.code),
    message: safeOperatorError(item.message),
  }))
  const code = diagnostics[0]?.code ?? 'interruption-resolution-unconfirmed'
  if (result.status === 'partial')
    return {
      kind: 'blocked',
      reason: `${code}: uw-partial; resolution may exist; no automatic retry or resume`,
      diagnostics,
    }
  if (result.status === 'uncertain')
    return { kind: 'blocked', reason: `${code}: uw-uncertain; no automatic retry or resume`, diagnostics }
  return {
    kind: 'blocked',
    reason: code === 'interruption-resolution-unconfirmed' ? `${code}: uw-refused` : code,
    diagnostics: [...diagnostics, { code: 'uw-refused', message: 'Resolution refused' }],
  }
}
