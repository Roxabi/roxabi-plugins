import { randomUUID } from 'node:crypto'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { createProductionActionPorts } from '../roxabi/uw-input-readers.ts'
import type { UwNativeHost } from '../roxabi/uw-installed-operations.ts'
import { defaultGit } from '../roxabi/workflow-checkout.ts'
import { createOmpFixPort, type OmpBuildExtensionApi, reviewControllerFor } from './omp-controller.ts'
import { beginFeatureUwOperation, cancelFeatureUwOperation } from './omp-feature-composition.ts'
import { rootContext } from './omp-feature-session.ts'
import type { CommandOperatorPort } from './omp-operator-confirmation.ts'
import type { NativeBatch } from './review-runtime/contracts.ts'
import { releaseTaskMask } from './review-runtime/task-mask-lease.ts'

export async function runNativeUwOperation(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  privateOperator: CommandOperatorPort,
  run: (operator: CommandOperatorPort, nativeHost: UwNativeHost) => Promise<void>,
): Promise<void> {
  const controller = reviewControllerFor(pi)
  controller.observeRootContext(ctx)
  const native = createOmpFixPort(pi)
  const runId = randomUUID()
  const abort = new AbortController()
  const session = ctx.sessionManager?.getSessionId()
  const cwd = ctx.cwd
  let batch: NativeBatch | null = null
  let acknowledged = false
  const started = Promise.withResolvers<void>()
  const leased: CommandOperatorPort = {
    executeConfirmed: privateOperator.executeConfirmed.bind(privateOperator),
    cancel() {
      privateOperator.cancel()
      abort.abort('uw-operation-cancelled')
      if (batch !== null) void native.stopOwned(batch, 'uw-operation-cancelled').catch(() => undefined)
    },
    progress(text) {
      privateOperator.progress(text)
    },
    held: privateOperator.held,
  }
  const operator = beginFeatureUwOperation(pi, leased)
  const nativeHost: UwNativeHost = {
    native,
    actionReaders: { git: defaultGit(), createPorts: createProductionActionPorts },
    signal: abort.signal,
    onBatch(value) {
      if (abort.signal.aborted || native.active() !== value || batch !== null)
        throw new Error('UW native batch ownership changed')
      batch = value
    },
    afterSettlement(value) {
      if (batch !== value || abort.signal.aborted) throw new Error('UW native batch is no longer owned')
      const terminal = controller.settlementFor(value)
      return terminal
        .then(() => {
          const turn = Promise.withResolvers<void>()
          setTimeout(turn.resolve, 0)
          return turn.promise
        })
        .then(async () => {
          await releaseTaskMask(controller, false, value)
          const root = controller.rootContext()
          if (
            abort.signal.aborted ||
            native.active() !== null ||
            !rootContext(ctx) ||
            !ctx.hasUI ||
            ctx.mode !== 'tui' ||
            ctx.cwd !== cwd ||
            ctx.sessionManager?.getSessionId() !== session ||
            root === null ||
            root.sessionManager?.getSessionId() !== session ||
            root.cwd !== cwd
          )
            throw new Error('UW native continuation lost its root command ownership')
        })
    },
    onStarted({ creationOperationId, assessmentStart }) {
      if (
        acknowledged ||
        !creationOperationId ||
        !assessmentStart.recordId ||
        assessmentStart.kind !== 'action-receipt' ||
        abort.signal.aborted ||
        batch === null ||
        native.active() !== batch
      )
        throw new Error('UW native batch was not owned at announcement')
      acknowledged = true
      pi.sendMessage(
        `uw-assessment-started: ${runId} ${creationOperationId} ${assessmentStart.scope.target} ${assessmentStart.recordId}`,
        { triggerTurn: false },
      )
      started.resolve()
    },
  }
  const stillHere = (): boolean => {
    if (ctx.cwd !== cwd) return false
    try {
      return ctx.sessionManager?.getSessionId() === session
    } catch {
      return false
    }
  }
  const completion = (async () => {
    try {
      await run(operator, nativeHost)
    } catch (error) {
      if (abort.signal.aborted || !stillHere()) return
      pi.sendMessage(`uw-stopped: ${error instanceof Error ? error.message : String(error)}`, {
        triggerTurn: false,
      })
    } finally {
      cancelFeatureUwOperation(pi, operator)
    }
  })()
  await Promise.race([started.promise, completion, privateOperator.held])
}
