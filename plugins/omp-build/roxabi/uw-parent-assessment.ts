import { randomUUID } from 'node:crypto'
import type { Gh } from '../adapters/github/types.ts'
import { bindExternalRef, type ExternalRecordRef, readComposedWorkflowHistory } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { NativeBatchCallbacks } from '../omp/review-runtime/contracts.ts'
import { actionRequest, observeHeadCode, uwSubject } from './delivery-action.ts'
import { sealReceipt } from './feature-action-receipt.ts'
import { publishNonImplementResult } from './feature-action-result.ts'
import { loadContracts } from './feature-engine.ts'
import {
  claimStartActivation,
  recordStartActivationFailed,
  recordStartClosedBeforeAdmission,
  recordStartNotActivated,
} from './feature-start-executions.ts'
import { prepareUwAction } from './uw-action-inputs.ts'
import { actionFailure } from './uw-action-result.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'
import type { UwReadPort } from './uw-contract.ts'
import { type CreatedChildAssessment, projectCreatedChildAssessment } from './uw-created-child-candidate.ts'
import type { ProductionReaderOptions } from './uw-input-readers.ts'
import type { UwNativeHost } from './uw-installed-operations.ts'

type AssessmentInput = CreatedChildAssessment & {
  host: UwNativeHost
  cwd: string
  gh: Gh
  actionOptions: ProductionReaderOptions
  reader: UwReadPort
  markAssessmentEffect(): void
}
type AssessmentResult = Result<{ assessment: ExternalRecordRef & { kind: 'action-receipt' } }>

async function confirmAssessmentSettlement(
  input: AssessmentInput,
  parent: Scope,
  assessment: ExternalRecordRef & { kind: 'action-receipt' },
  start: ExternalRecordRef & { kind: 'action-receipt' },
  operationId: string,
  canContinue: () => boolean,
  finish: (value: AssessmentResult) => void,
  onAbort: () => void,
): Promise<void> {
  if (!canContinue() || input.host.signal.aborted) {
    onAbort()
    return
  }
  const history = await readComposedWorkflowHistory([parent], { cwd: input.cwd, gh: input.gh })
  if (!history.ok) {
    finish({ ok: false, diagnostics: history.diagnostics })
    return
  }
  const own = history.histories.find(
    (entry) => entry.source.scope.repository === parent.repository && entry.source.scope.target === parent.target,
  )
  const bound = own && bindExternalRef(assessment, own)
  if (
    !bound?.ok ||
    bound.value.kind !== 'action-receipt' ||
    bound.value.payload.action !== 'assess-spec' ||
    bound.value.payload.phase !== 'result' ||
    bound.value.payload.actionId !== operationId ||
    bound.value.payload.start.recordId !== start.recordId
  ) {
    finish(actionFailure('action-input-missing', 'Canonical assessment result readback is unavailable'))
    return
  }
  if (!canContinue() || input.host.signal.aborted) {
    onAbort()
    return
  }
  finish({ ok: true, value: { assessment } })
}

function claimAssessmentDispatch(
  input: AssessmentInput,
  start: ExternalRecordRef & { kind: 'action-receipt' },
  operationId: string,
  onAbort: () => void,
): AssessmentResult | null {
  if (input.host.signal.aborted) {
    recordStartNotActivated(start)
    input.host.signal.removeEventListener('abort', onAbort)
    return actionFailure('action-input-missing', 'Assessment native run was cancelled')
  }
  if (!claimStartActivation(start, operationId)) {
    input.host.signal.removeEventListener('abort', onAbort)
    return actionFailure('action-input-missing', 'Assessment START is already observed')
  }
  return null
}

/** Open and settle one real native assess-spec action for the already-prepared creation. */
export async function assessCreatedChildForParent(input: AssessmentInput): Promise<AssessmentResult> {
  const parent = input.creation.parentObservation?.parent
  if (parent === undefined || input.host.signal.aborted)
    return actionFailure('action-input-missing', 'Active parent or live native host is unavailable')
  const home = input.before.histories.find(
    (history) => history.source.scope.repository === parent.repository && history.source.scope.target === parent.target,
  )
  if (home === undefined || !home.source.complete)
    return actionFailure('action-input-missing', 'Parent history is unavailable')
  const mandate = currentAccountedMandate(home)
  if (!mandate.ok) return mandate
  const read = await input.reader.readUw(parent)
  const candidate = await projectCreatedChildAssessment(input, read)
  if (!candidate.ok) return candidate
  const loaded = await loadContracts()
  if ('missing' in loaded) return actionFailure('action-input-missing', `Missing ${loaded.missing}`)
  const code = await observeHeadCode(input.host.actionReaders.git, input.cwd, parent.repository)
  if (!code.ok) return actionFailure('action-input-missing', code.reason)
  const operationId = randomUUID()
  const request = actionRequest({
    actionId: operationId,
    purpose: 'assess-spec',
    subject: uwSubject(parent, null),
    code: code.code,
    operands: candidate.value.operands,
  })
  const prepared = await prepareUwAction(
    request,
    input.host.actionReaders.createPorts({
      ...input.actionOptions,
      git: input.host.actionReaders.git,
      createdChildAssessment: input,
    }),
  )
  if (!prepared.ok) return prepared
  if (input.host.signal.aborted || input.host.native.active() !== null)
    return actionFailure('action-input-missing', 'Native host is no longer available')
  input.markAssessmentEffect()
  const opened = await sealReceipt({
    loaded,
    history: home,
    scope: parent,
    cwd: input.cwd,
    gh: input.gh,
    parents: input.before.histories.filter((history) => history !== home),
    operationId,
    action: 'assess-spec',
    mandate: { scope: parent, recordId: mandate.value.recordId, kind: 'mandate' },
    origin: candidate.value.operands.origin,
    exactInputs: candidate.value.operands.exactInputs,
    prepared: prepared.value,
  })
  if (opened.kind !== 'action' || opened.node !== 'assess-spec' || opened.start.kind !== 'action-receipt')
    return actionFailure(
      'action-input-missing',
      opened.kind === 'blocked' ? opened.reason : 'Assessment start was not confirmed',
    )
  const start = { ...opened.start, kind: 'action-receipt' as const }
  const batch = opened.followUp
  const outcome = Promise.withResolvers<Result<{ assessment: ExternalRecordRef & { kind: 'action-receipt' } }>>()
  let settled = false
  const finish = (value: Result<{ assessment: ExternalRecordRef & { kind: 'action-receipt' } }>) => {
    if (!settled) {
      settled = true
      outcome.resolve(value)
    }
  }
  const onAbort = () => finish(actionFailure('action-input-missing', 'Assessment native run was cancelled'))
  input.host.signal.addEventListener('abort', onAbort, { once: true })
  const callbacks: NativeBatchCallbacks = {
    onComplete: async (result, canContinue) => {
      if (!canContinue() || input.host.signal.aborted) {
        onAbort()
        return
      }
      const published = await publishNonImplementResult({ cwd: input.cwd, gh: input.gh, start, result })
      if (!published.published) {
        finish(actionFailure('action-input-missing', `Assessment result was not confirmed: ${published.reason}`))
        return
      }
      const assessment = { scope: parent, recordId: published.recordId, kind: 'action-receipt' as const }
      const fence = input.host.afterSettlement(batch)
      void fence
        .then(() =>
          confirmAssessmentSettlement(input, parent, assessment, start, operationId, canContinue, finish, onAbort),
        )
        .catch((error: unknown) =>
          finish(
            actionFailure(
              'action-input-missing',
              `Assessment settlement failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        )
    },
    onStop: async (reason, result, stop) => {
      if (stop.kind === 'interrupted' && stop.proof === 'not-dispatched' && result !== null) {
        try {
          const published = await publishNonImplementResult({ cwd: input.cwd, gh: input.gh, start, result, stop })
          if (published.published) recordStartClosedBeforeAdmission(start, batch.operationId)
        } catch {
          // A failed or uncertain publication keeps the activated START non-resolvable.
        }
      }
      finish(actionFailure('action-input-missing', `Assessment native run stopped: ${reason}`))
    },
  }
  const dispatch = async (): Promise<AssessmentResult> => {
    const refused = claimAssessmentDispatch(input, start, batch.operationId, onAbort)
    if (refused !== null) return refused
    let activated = false
    try {
      input.host.native.activate(batch, callbacks)
      activated = true
      input.host.onBatch(batch)
      if (input.host.signal.aborted) {
        void input.host.native.stopOwned(batch, 'assessment-cancelled')
        return await outcome.promise
      }
      await input.host.native.announce(batch)
      if (input.host.signal.aborted) return await outcome.promise
      input.host.onStarted({ creationOperationId: input.core.operationId, assessmentStart: start })
      return await outcome.promise
    } catch (error) {
      if (activated) await input.host.native.stopOwned(batch, 'assessment-dispatch-failed').catch(() => undefined)
      else recordStartActivationFailed(start, batch.operationId)
      return actionFailure(
        'action-input-missing',
        `Assessment dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      input.host.signal.removeEventListener('abort', onAbort)
    }
  }
  return dispatch()
}
