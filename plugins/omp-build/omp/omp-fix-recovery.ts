import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import {
  bindExternalRef,
  ompBuildRecoveryPrParametersJsonSchema,
  ompBuildRecoveryPrParametersSchema,
  viewer,
} from '../dist/contracts.js'
import { createPreparationCohort } from '../host/preparation-cohort.ts'
import type { FixRecord } from '../roxabi/fix-contract.ts'
import { failure } from '../roxabi/fix-contract.ts'
import { createFixDispositionStore } from '../roxabi/fix-disposition-store.ts'
import { createIdentity, startFixRun } from '../roxabi/fix-entry-lifecycle.ts'
import { confirmReviewBoundContinuation } from '../roxabi/fix-entry-review-bound.ts'
import { defaultGh } from '../roxabi/fix-entry-target-core.ts'
import { FixExecutionFence } from '../roxabi/fix-execution-fence.ts'
import { runReviewBoundFixWorkflow } from '../roxabi/fix-execution-runner.ts'
import { readFixOwnerHistories } from '../roxabi/fix-owner-admission-observation.ts'
import { acquireFixOwnerLease } from '../roxabi/fix-owner-lease.ts'
import { reserveFixOwner, reserveFixRecovery } from '../roxabi/fix-records.ts'
import { executeFixRecoveryAdoption } from '../roxabi/fix-recovery-adoption-execution.ts'
import { publishRecoveryClaimOwner } from '../roxabi/fix-recovery-claim-owner.ts'
import { executeFixRecoveryClose } from '../roxabi/fix-recovery-close-execution.ts'
import { readFixRecoveryCurrent } from '../roxabi/fix-recovery-current-observation.ts'
import { preflightRecoveryDecision } from '../roxabi/fix-recovery-decision-preflight.ts'
import { resolveRecoveryEntry } from '../roxabi/fix-recovery-entry-target.ts'
import { prepareRecoveryReviewBasis } from '../roxabi/fix-recovery-review-basis.ts'
import { withRoxabiGitHubPolicy } from '../roxabi/github-policy.ts'
import { createInstalledUwReadPort } from '../roxabi/uw-read-port.ts'
import { nextReviewStep } from '../skills/feature/workflow-review-state.js'
import { hostPluginPin } from './host-plugin-pin.ts'
import { createHostUwOperations } from './host-uw-operations.ts'
import { claimFixIngress, createOmpFixPort, type OmpBuildExtensionApi } from './omp-controller.ts'
import {
  readRecoveryRequestHistory,
  recoveryPublisher,
  reportRecoveryRun,
  withRecoveryLease,
} from './omp-fix-recovery-runtime.ts'
import { createOperatorConfirmation } from './omp-operator-confirmation.ts'
import { captureNativeRootLifetime } from './review-runtime/native-sdk-adapter.ts'

function reason(result: { diagnostics: readonly string[] }): Error {
  return new Error(result.diagnostics.join(','))
}

async function recover(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  pr: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  const releaseIngress = claimFixIngress(pi)
  const cohort = createPreparationCohort()
  try {
    return await cohort.run(async () => {
      const root = await captureNativeRootLifetime(ctx)
      if (root === null) throw new Error('fix-recovery-root-unavailable')
      const gh = defaultGh
      const github = withRoxabiGitHubPolicy({ cwd: ctx.cwd, gh })
      const login = await viewer(github)
      const reader = createInstalledUwReadPort({ cwd: ctx.cwd, readAuthor: login })
      const entry = await resolveRecoveryEntry({ cwd: ctx.cwd, pr: String(pr), gh, github, reader })
      if (!entry.ok) throw reason(entry)
      const selected = entry.value
      const operator = createOperatorConfirmation(ctx, { signal })
      const pluginPin = await hostPluginPin(pi, ctx)
      const readCurrent = (
        lease: Parameters<typeof readFixRecoveryCurrent>[0]['lease'],
        decision?: Extract<FixRecord, { kind: 'decision' }>,
      ) =>
        readFixRecoveryCurrent({
          uw: selected.uw,
          opening: selected.opening,
          settlement: selected.settlement,
          cwd: ctx.cwd,
          github,
          gh,
          reader,
          lease,
          root: root.lifetime,
          rootCurrent: root.current,
          trustedPlugin: pluginPin,
          refreshTarget: selected.refreshTarget,
          decision,
        })
      if (selected.discovery.phase.kind !== 'decided') {
        return withRecoveryLease(selected.binding.destination, async (lease) => {
          const fresh = await resolveRecoveryEntry({ cwd: ctx.cwd, pr: String(pr), gh, github, reader })
          if (!fresh.ok) throw reason(fresh)
          if (
            fresh.value.admission.opened.recordId !== selected.admission.opened.recordId ||
            fresh.value.admission.settled.recordId !== selected.admission.settled.recordId
          )
            throw new Error('fix-recovery-owner-changed')
          const closed = await executeFixRecoveryClose({
            control: reserveFixRecovery(createIdentity(), selected.pullRequest),
            lease,
            github,
            operator,
            rootCurrent: root.current,
            readCurrent: () => readCurrent(lease),
          })
          if (!closed.ok) throw reason(closed)
          return 'Interrupted fix ownership was neutrally closed; no correction was started.'
        })
      }
      const phase = selected.discovery.phase
      const history = selected.histories.find(
        (item) =>
          item.source.scope.repository === selected.pullRequest.repository &&
          item.source.scope.target === selected.pullRequest.target,
      )
      if (history === undefined) throw new Error('fix-recovery-request-history-unavailable')
      const request = bindExternalRef(
        { scope: phase.request.identity.scope, kind: 'fix-request', recordId: phase.request.identity.recordId },
        history,
      )
      const decision = bindExternalRef(
        { scope: phase.decision.identity.scope, kind: 'decision', recordId: phase.decision.identity.recordId },
        history,
      )
      if (!request.ok || request.value.kind !== 'fix-request' || !decision.ok || decision.value.kind !== 'decision')
        throw new Error('fix-recovery-review-decision-unavailable')
      const originalRequest = request.value
      const originalDecision = decision.value
      const existingReviewId = originalRequest.payload.existingReviewId
      if (existingReviewId === null) throw new Error('fix-recovery-review-decision-unavailable')
      const physicalIdentity = createIdentity()
      const identity = { ...physicalIdentity, runId: originalRequest.runId }
      const claim = reserveFixOwner(identity, selected.uw)
      const control = reserveFixRecovery(identity, selected.pullRequest)
      const fence = new FixExecutionFence()
      fence.bindCohort(cohort)
      fence.bindRoot(root.current, root.lifetime)
      fence.closeIngress()
      const native = createOmpFixPort(pi, fence)
      const operations = await createHostUwOperations(ctx, operator, pluginPin)
      const workflow = {
        nextReviewStep: (cwd: string, number: number, options: object) =>
          nextReviewStep(cwd, number, { ...options, pluginPin }),
      }
      const readHistory = () =>
        readRecoveryRequestHistory({ uw: selected.uw, pullRequest: selected.pullRequest, github, reader })
      const publisher = recoveryPublisher(selected.uw, selected.pullRequest, github, fence, root.current)
      const entryInput = {
        cwd: ctx.cwd,
        reference: String(pr),
        reviewId: existingReviewId,
        scope: originalRequest.payload.scope,
        native,
        workflow,
        operations,
        uw: reader,
        github,
        pluginPin,
      }
      const run = startFixRun({
        identity,
        native,
        operations,
        drive: async (_identity, runtime) => {
          const acquired = await acquireFixOwnerLease({
            destination: selected.binding.destination,
            owner: claim,
            priorNamespace: selected.admission.priorNamespace,
            fence,
          })
          if (!acquired.ok) return acquired
          const lease = fence.destinationLease()
          if (lease === null || fence.destinationLeaseFacts()?.host === null)
            return failure('fix-recovery-host-unqualified')
          const product = {
            native,
            publisher,
            runtime,
            readHistory,
            github,
            dispositionStore: createFixDispositionStore(selected.uw, github),
          }
          const basis = async () => {
            const refreshed = await selected.refreshTarget()
            if (!refreshed.ok) return refreshed
            return prepareRecoveryReviewBasis({
              entry: entryInput,
              requestInput: {
                cwd: ctx.cwd,
                reference: String(pr),
                contextTarget: refreshed.value.target,
                rawOperatorRequest: null,
                scope: originalRequest.payload.scope,
                identity,
                publishBinding: refreshed.value.binding,
                nativeTasks: [],
                operations,
                uw: selected.uw,
              },
              target: refreshed.value.target,
              resolver: selected.resolver,
              originalRequest,
              originalDecision,
              readHistory,
              github,
              signal: runtime.signal,
            })
          }
          const live = async () => {
            const current = await readCurrent(lease, originalDecision)
            if (!current.ok) return current
            const reconstructed = await basis()
            if (!reconstructed.ok) return reconstructed
            const preflight = await preflightRecoveryDecision(
              reconstructed.value.prepared,
              originalDecision,
              product,
              identity,
            )
            return preflight.ok
              ? { ok: true as const, value: { ...current.value, nativePreparation: preflight.value } }
              : preflight
          }
          return executeFixRecoveryAdoption({
            control,
            claimReservation: claim,
            lease,
            github,
            operator,
            rootCurrent: root.current,
            readCurrent: live,
            claimAndContinue: async ({ control: confirmed, current }) => {
              const reconstructed = await basis()
              if (!reconstructed.ok) return reconstructed
              const opened = await publishRecoveryClaimOwner({
                control: confirmed,
                reservation: claim,
                identity,
                fence,
                current: current.current,
                graph: current.graph,
                histories: current.histories,
                nativePreparation: current.nativePreparation,
                github,
                prepared: reconstructed.value.prepared,
                readHistories: async () => {
                  const raw = await readFixOwnerHistories({
                    uw: selected.uw,
                    pullRequest: selected.pullRequest,
                    github,
                    reader,
                  })
                  return raw.ok ? { ok: true, value: raw.value.histories } : raw
                },
              })
              if (!opened.ok) return opened
              runtime.bindContinuation?.(() =>
                confirmReviewBoundContinuation(
                  reconstructed.value.review,
                  selected.target,
                  github,
                  readHistory,
                  selected.binding.localBranch,
                  selected.binding.defaultBranch,
                  reader,
                  selected.opening.payload.common.mandate.recordId,
                  undefined,
                  originalRequest,
                ),
              )
              return runReviewBoundFixWorkflow(reconstructed.value.prepared, originalDecision, product, identity)
            },
          })
        },
      })
      return reportRecoveryRun(pi, run, fence, selected.pullRequest.target)
    })
  } finally {
    releaseIngress()
  }
}

export function registerOmpFixRecoveryTool(pi: OmpBuildExtensionApi): void {
  pi.registerTool({
    name: 'omp_build_recover_interrupted_fix',
    label: 'Recover interrupted fix',
    approval: 'write',
    description: 'Confirm a bounded neutral close or resume the same authenticated unstarted review-bound correction.',
    parameters: ompBuildRecoveryPrParametersJsonSchema,
    async execute(_id, params, signal, _update, ctx) {
      const parsed = ompBuildRecoveryPrParametersSchema.safeParse(params)
      if (!parsed.success) throw new Error('invalid-omp-build-recover-interrupted-fix-parameters')
      const text = await recover(pi, ctx, parsed.data.pr, signal)
      return { content: [{ type: 'text', text }] }
    },
  })
}
