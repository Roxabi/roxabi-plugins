import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import {
  hasNativeUserInterruptFlag,
  ompBuildStartFixParametersJsonSchema,
  ompBuildStartFixParametersSchema,
  ompBuildStartReviewParametersJsonSchema,
  ompBuildStartReviewParametersSchema,
} from '../dist/contracts.js'
import type { PreparedEpicReview } from '../roxabi/epic-range-review'
import {
  abortOwnedFeatureWatch,
  type FeatureFixTerminal,
  type FeatureSessionReason,
  type FeatureWorkflow,
  loadFeatureWorkflow,
  pauseOwnedFeatureOnSessionEnd,
  runInstalledFeatureCommand,
} from '../roxabi/feature-entry'
import { type FixRun, type FixStart, startAdmittedCiCorrection, startDefaultFix } from '../roxabi/fix-entry'
import { ReviewProduct, type ReviewPublisher } from '../roxabi/review'
import { createPreparedReviewRunner } from '../roxabi/review-entry'
import { prepareReviewInputs } from '../roxabi/review-inputs'
import { nextReviewStep, validateReviewInput } from '../skills/feature/workflow.js'
import {
  BUN_TEST_DENY_REASON,
  evalGuard,
  extractShellCommand,
  extractWriteContent,
  hasProjectContract,
  isBunTestBlocked,
  PRINCIPAL_FREEZE_REASON,
  PROJECT_CONTRACT_FILES,
  scanSecurityContent,
  shouldBlockPrincipalSwitch,
} from './guards'
import {
  createNativeReviewPort,
  installNativeBatchBridge,
  type NativeBatch,
  NativeBatchController,
  type NativeExtension,
} from './review-runtime'

export { type FixRun, type FixStart, startAdmittedCiCorrection, startDefaultFix } from '../roxabi/fix-entry'
export { ROXABI_STOP_AUTHOR, withRoxabiGitHubPolicy } from '../roxabi/github-policy'
export { createGitHubRecordPublisher } from '../roxabi/github-publisher'
export { nativeContributionPayload } from '../roxabi/native-contribution'
export {
  nativeFixProfileByAction,
  nativePanelProfileByRole,
  nativeReviewProfiles,
} from '../roxabi/native-review-profiles'
export { persistRequiredReviewStop, ReviewProduct } from '../roxabi/review'
export { loadReviewConfig } from '../roxabi/review-config'
export { allocateReviewPanel, createRecallTask } from '../roxabi/review-context'
export { createPreparedReviewRunner } from '../roxabi/review-entry'
export { CanonicalReviewRunner } from '../roxabi/review-runner'
export { createNativeReviewPort, installNativeBatchBridge, NativeBatchController } from './review-runtime'

const reviewControllers = new WeakMap<object, NativeBatchController>()

type OwnedFixRun = {
  run: FixRun
  reporting: Promise<void>
  release: Promise<void>
  stopping?: Promise<void>
  tearingDown?: true
}
const ownedFixRuns = new WeakMap<object, OwnedFixRun>()

export type OmpBuildExtensionApi = Pick<
  ExtensionAPI,
  'on' | 'registerCommand' | 'registerTool' | 'sendUserMessage' | 'sendMessage' | 'exec'
> & {
  events: Pick<ExtensionAPI['events'], 'on'>
}

/** Terminal/control reports need only non-steering sendMessage. */
type TerminalStatusHost = Pick<ExtensionAPI, 'sendMessage'>
/** Fix/CI ownership + terminal notify: native bridge plus sendMessage. */
type FixHost = NativeExtension & TerminalStatusHost

/** Operator-visible terminal/control status: never starts or steers a model turn. */
function reportFeatureTerminalStatus(pi: TerminalStatusHost, text: string): void {
  pi.sendMessage(text, { triggerTurn: false })
}

function rootContext(ctx: ExtensionContext): boolean {
  return ctx.agent.kind === 'main' && ctx.agent.depth === 0
}

function interruptOwnedFixRun(pi: NativeExtension, reason: string): void {
  const owned = ownedFixRuns.get(pi as object)
  if (!owned || owned.stopping !== undefined) return
  owned.tearingDown = true
  owned.stopping = owned.run.stop(reason).catch((error) => {
    console.error(
      `omp-build: fix run ${owned.run.runId} stop failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  })
}

function interruptExactOwnedFixRun(pi: NativeExtension, owned: OwnedFixRun, reason: string): void {
  if (ownedFixRuns.get(pi as object) !== owned) return
  interruptOwnedFixRun(pi, reason)
}

function reviewControllerFor(pi: NativeExtension): NativeBatchController {
  const extension = pi as object
  const existing = reviewControllers.get(extension)
  if (existing) return existing
  const controller = new NativeBatchController()
  installNativeBatchBridge(pi, controller)
  reviewControllers.set(extension, controller)
  return controller
}

/** Feature/Epic host entry: the caller supplies only a real authorization/publishing boundary. */
export function createOmpReviewProduct(pi: NativeExtension, publisher: ReviewPublisher): ReviewProduct {
  if (ownedFixRuns.has(pi as object)) throw new Error('fix-run-already-active')
  return new ReviewProduct(
    createNativeReviewPort(pi, reviewControllerFor(pi)),
    publisher,
    () => !ownedFixRuns.has(pi as object),
  )
}

/** Correction batches share the same guarded native bridge and native continuation. */
export function createOmpFixPort(
  pi: NativeExtension,
): Pick<NativeBatchController, 'active' | 'activate' | 'stopOwned'> & { announce(batch: NativeBatch): Promise<void> } {
  const controller = reviewControllerFor(pi)
  return {
    active: controller.active.bind(controller),
    activate: controller.activate.bind(controller),
    stopOwned: controller.stopOwned.bind(controller),
    announce: createNativeReviewPort(pi, controller).announce,
  }
}
async function prepareInstalledEpicRangeReview(
  pi: NativeExtension,
  review: PreparedEpicReview,
  onComplete: () => Promise<void>,
): Promise<void> {
  let completionInvoked = false
  const publisher: ReviewPublisher = {
    authorize: (context, stage) => review.publisher.authorize(context, stage),
    publishInventory: (prepared) => review.publisher.publishInventory(prepared),
    publishRawContribution: (prepared, child) => review.publisher.publishRawContribution(prepared, child),
    completeStage: async (prepared, result, contributions) => {
      const next = await review.publisher.completeStage(prepared, result, contributions)
      if (next === null && !completionInvoked) {
        completionInvoked = true
        await onComplete()
      }
      return next
    },
    publishRequiredStop: (context, stop, options) => review.publisher.publishRequiredStop(context, stop, options),
    stop: (context, reason, result) => review.publisher.stop(context, reason, result),
  }
  await createOmpReviewProduct(pi, publisher).prepareEpicRangeReview(review.context, review.prepared)
}

async function dispatchDefaultReview(
  pi: NativeExtension,
  ctx: ExtensionContext,
  args: string,
  onComplete?: () => Promise<void>,
  prepareReview: typeof prepareReviewInputs = prepareReviewInputs,
): Promise<void> {
  if (ownedFixRuns.has(pi as object)) throw new Error('fix-run-already-active')
  const supplied = args.trim()
  if (supplied !== '' && !/^[1-9]\d*$/.test(supplied))
    throw new Error('/dev-review accepts one positive pull-request number')
  const contextWindow = ctx.model?.contextWindow
  if (typeof contextWindow !== 'number' || !Number.isSafeInteger(contextWindow) || contextWindow <= 0)
    throw new Error('current model has no usable context window')
  const prepared = await prepareReview({
    cwd: ctx.cwd,
    pr: supplied === '' ? undefined : Number(supplied),
    contextWindow,
  })
  if (!prepared.ok)
    throw new Error(`review-input-preparation-refused:${prepared.diagnostics.map((item) => item.code).join(',')}`)
  const input = prepared.value
  const admission = await nextReviewStep(ctx.cwd, input.pr.number, { reviewing: true })
  if (admission.action !== 'review') throw new Error(`review-not-authorized:${admission.action}`)
  const authorize = async (stage: 'initial' | 'recall' | 'synthesis') => {
    const validation = await validateReviewInput(ctx.cwd, input.pr.number, input.pr.head, input.capture.input)
    if (!validation.ok) return { ok: false as const, reason: `${stage}:${validation.reason}` }
    return { ok: true as const }
  }
  const runner = createPreparedReviewRunner(
    input,
    { cwd: ctx.cwd, readAuthor: input.automationLogin, writeAuthor: input.automationLogin },
    authorize,
  )
  let completionInvoked = false
  const publisher: ReviewPublisher =
    onComplete === undefined
      ? runner
      : {
          authorize: (context, stage) => runner.authorize(context, stage),
          publishInventory: (prepared) => runner.publishInventory(prepared),
          publishRawContribution: (prepared, child) => runner.publishRawContribution(prepared, child),
          completeStage: async (prepared, result, contributions) => {
            const next = await runner.completeStage(prepared, result, contributions)
            if (next === null && !completionInvoked) {
              completionInvoked = true
              await onComplete()
            }
            return next
          },
          publishRequiredStop: () => runner.publishRequiredStop(),
          stop: (context, reason) => runner.stop(context, reason),
        }
  if (ownedFixRuns.has(pi as object)) throw new Error('fix-run-already-active')
  const product = new ReviewProduct(
    createNativeReviewPort(pi, reviewControllerFor(pi)),
    publisher,
    () => !ownedFixRuns.has(pi as object),
  )
  await product.preparePullRequestReview(runner.context, runner.initialBatch())
}

async function dispatchDefaultFix(
  pi: FixHost,
  ctx: ExtensionContext,
  args: string,
  options: { reference?: string; reviewId?: string } = {},
): Promise<FixStart> {
  const key = pi as object
  if (ownedFixRuns.has(key)) throw new Error('fix-run-already-active')
  const run = startDefaultFix({
    cwd: ctx.cwd,
    args,
    reference: options.reference,
    reviewId: options.reviewId,
    contextWindow: typeof ctx.model?.contextWindow === 'number' ? ctx.model.contextWindow : undefined,
    native: createOmpFixPort(pi),
    workflow: { nextReviewStep },
  })
  const notify = async (text: string): Promise<void> => {
    if (ownedFixRuns.get(key)?.run === run && ownedFixRuns.get(key)?.tearingDown) {
      console.error(`omp-build: fix run ${run.runId} ended during teardown: ${text}`)
      return
    }
    try {
      reportFeatureTerminalStatus(pi, text)
    } catch (error) {
      console.error(
        `omp-build: fix terminal notification failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const reporting = run.completion.then(
    (result) =>
      notify(
        result.ok
          ? `/fix ${run.runId} completed with confirmed record ${result.value.recordId}.`
          : `/fix ${run.runId} stopped: ${result.diagnostics.join(', ')}`,
      ),
    (error) => notify(`/fix ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}`),
  )
  const releaseOwned = async () => {
    const owned = ownedFixRuns.get(key)
    if (owned?.run !== run) return
    await owned.stopping
    if (ownedFixRuns.get(key)?.run === run) ownedFixRuns.delete(key)
  }
  const release = reporting.then(releaseOwned, releaseOwned)
  ownedFixRuns.set(key, { run, reporting, release })
  return run.started
}

async function dispatchAdmittedCiCorrection(
  pi: FixHost,
  ctx: ExtensionContext,
  input: { reference: string; attributionRecordId: string; scope: string },
): Promise<FixRun> {
  const key = pi as object
  if (ownedFixRuns.has(key)) throw new Error('fix-run-already-active')
  const run = startAdmittedCiCorrection({
    cwd: ctx.cwd,
    reference: input.reference,
    attributionRecordId: input.attributionRecordId,
    scope: input.scope,
    native: createOmpFixPort(pi),
    workflow: { nextReviewStep },
  })
  const notify = async (text: string): Promise<void> => {
    if (ownedFixRuns.get(key)?.run === run && ownedFixRuns.get(key)?.tearingDown) {
      console.error(`omp-build: ci correction ${run.runId} ended during teardown: ${text}`)
      return
    }
    try {
      reportFeatureTerminalStatus(pi, text)
    } catch (error) {
      console.error(
        `omp-build: ci correction notification failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  const reporting = run.terminal.then(
    (terminal) =>
      notify(
        terminal.status === 'complete'
          ? `ci-correction ${run.runId} completed with confirmed record ${terminal.recordId}.`
          : `ci-correction ${run.runId} stopped: ${terminal.diagnostics.join(', ')}`,
      ),
    (error) => notify(`ci-correction ${run.runId} failed: ${error instanceof Error ? error.message : String(error)}`),
  )
  const releaseOwned = async () => {
    const owned = ownedFixRuns.get(key)
    if (owned?.run !== run) return
    await owned.stopping
    if (ownedFixRuns.get(key)?.run === run) ownedFixRuns.delete(key)
  }
  const release = reporting.then(releaseOwned, releaseOwned)
  ownedFixRuns.set(key, { run, reporting, release })
  return run
}

const SKILLS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills')

/**
 * Slash commands whose product path is a skill body. Native review, correction,
 * and feature commands are registered separately below because they construct
 * their actual host-authorized pipelines rather than dumping instructions for one.
 */
const SKILL_COMMANDS: readonly { name: string; skill?: string; description: string; requires: readonly string[] }[] = [
  {
    name: 'feature',
    description: 'OMP-only feature cycle — frame, GitHub issue, worktree, implement, bounded review/fix, land.',
    requires: ['dev-review', 'fix'],
  },
  {
    name: 'dev-review',
    description: 'Prepare and dispatch a host-authorized native structured review.',
    requires: ['dev-review'],
  },
  {
    name: 'fix',
    description: 'Prepare and dispatch a host-authorized native correction from confirmed review records.',
    requires: ['fix'],
  },
  {
    // The optional tail (#495). Offered after a ticket lands, never chained:
    // `/feature` prints the offer and stops, and neither body is reachable from
    // the review→fix loop.
    name: 'promote',
    description: 'Promote staging→main — pre-flight, version, changelog, PR, tag',
    requires: [],
  },
  {
    name: 'cleanup',
    description: 'Clean merged branches, worktrees and remotes after verification',
    requires: [],
  },
  {
    name: 'ci-watch',
    description: 'Watch every check on a PR head, then the merge, until the script deadline',
    requires: [],
  },
]

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---\n', 4)
  if (end === -1) return markdown
  return markdown.slice(end + 5)
}

export type OmpBuildExtensionOptions = {
  exists?: (path: string) => boolean
  featureWorkflow?: FeatureWorkflow
  principalCwd?: (cwd: string) => boolean
  prepareReview?: typeof prepareReviewInputs
  startFeatureFix?: (reference: string) => Promise<{ terminal: Promise<FeatureFixTerminal> }>
}

const requireFromIndex = createRequire(import.meta.url)

function isInstalledPrincipal(cwd: string): boolean {
  try {
    const freeze = requireFromIndex('../hooks/lib/principal-freeze.cjs') as {
      isPrincipalCwd?: (cwd: string) => boolean
    }
    return freeze.isPrincipalCwd?.(cwd) === true
  } catch {
    return false
  }
}
export default function ompBuildExtension(pi: OmpBuildExtensionApi, options: OmpBuildExtensionOptions = {}): void {
  const { exists = existsSync } = options
  // User-only by construction, on the one lane that exists: `registerCommand` is
  // the slash lane, `registerTool` is the LLM one (omp://extensions.md), and the
  // model cannot reach a command. That alone is the property. A body's
  // `disable-model-invocation` is not a second gate — omp normalises it to `hide`,
  // which omits the skill from the prompt listing while `skill://<name>` and
  // `/skill:<name>` still reach it (measured on omp 18.2.9).
  //
  // No `rewriteHarnessPaths` here: nothing this plugin dumps carries a
  // `${CLAUDE_*}` path token to expand — agent bodies *and* skill bodies, the
  // surface these commands added, are held to that by
  // `agents/__tests__/roster.test.ts` ("cites no plugin-root token").
  reviewControllerFor(pi)
  const interruptOwnedFeatureWork = async (reason: string): Promise<void> => {
    abortOwnedFeatureWatch(pi as object)
    const controller = reviewControllerFor(pi)
    controller.inhibitFeatureContinuation()
    interruptOwnedFixRun(pi, reason)
    const active = controller.active()
    if (active) await controller.stopOwned(active, reason)
  }
  const pauseFeatureOnSessionEnd = (reason: FeatureSessionReason): Promise<void> => {
    const local = interruptOwnedFeatureWork(reason)
    return (async () => {
      const workflow = options.featureWorkflow ?? (await loadFeatureWorkflow().catch(() => null))
      if (workflow === null) {
        await local
        reportFeatureTerminalStatus(pi, 'feature-stopped: feature-workflow-unavailable')
        return
      }
      try {
        await pauseOwnedFeatureOnSessionEnd(
          pi as object,
          reason,
          workflow,
          () => local,
          async (text) => {
            reportFeatureTerminalStatus(pi, text)
          },
        )
      } catch (error) {
        reportFeatureTerminalStatus(pi, `feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
  }
  pi.on('session_stop', (event, ctx) => {
    if (!rootContext(ctx)) return
    // Ordinary idle settle only: native bridge settle/watchSettleAbort handles batches.
    // Do not product-pause or abort CI watch here (D2-B). Do not treat signal aborts as §85.
    if (event.signal.aborted) {
      interruptOwnedFixRun(pi, 'session-settle-aborted')
      return
    }
    const owned = ownedFixRuns.get(pi as object)
    if (owned !== undefined) {
      event.signal.addEventListener('abort', () => interruptExactOwnedFixRun(pi, owned, 'session-settle-aborted'), {
        once: true,
      })
    }
  })
  pi.on('message_end', (event, ctx) => {
    if (!rootContext(ctx)) return
    const message = event.message
    if (
      !message ||
      typeof message !== 'object' ||
      !('role' in message) ||
      message.role !== 'assistant' ||
      !('stopReason' in message) ||
      message.stopReason !== 'aborted' ||
      !('errorId' in message) ||
      !hasNativeUserInterruptFlag(typeof message.errorId === 'number' ? message.errorId : undefined)
    ) {
      return
    }
    return pauseFeatureOnSessionEnd('session-stop')
  })
  pi.on('session_switch', (_event, ctx) => {
    if (!rootContext(ctx)) return
    interruptOwnedFixRun(pi, 'session-switched')
    return pauseFeatureOnSessionEnd('session-switch')
  })
  pi.on('session_shutdown', (_event, ctx) => {
    if (!rootContext(ctx)) return
    interruptOwnedFixRun(pi, 'session-shutdown')
    return pauseFeatureOnSessionEnd('session-shutdown')
  })
  pi.registerTool({
    name: 'omp_build_start_review',
    label: 'Start structured review',
    description: 'Prepare and dispatch the host-authorized native review for one existing pull request.',
    parameters: ompBuildStartReviewParametersJsonSchema,
    approval: 'write',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = ompBuildStartReviewParametersSchema.safeParse(params)
      if (!parsed.success) throw new Error('invalid-omp-build-start-review-parameters')
      await dispatchDefaultReview(pi, ctx, parsed.data.pr === undefined ? '' : String(parsed.data.pr))
      return {
        content: [
          { type: 'text', text: 'Native review inventory was confirmed and the prepared batch was announced.' },
        ],
      }
    },
  })
  pi.registerTool({
    name: 'omp_build_start_fix',
    label: 'Start structured correction',
    description:
      'Prepare and dispatch the host-authorized native correction for an existing target or confirmed review.',
    parameters: ompBuildStartFixParametersJsonSchema,
    approval: 'write',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const parsed = ompBuildStartFixParametersSchema.safeParse(params)
      if (!parsed.success) throw new Error('invalid-omp-build-start-fix-parameters')
      const start = await dispatchDefaultFix(pi, ctx, parsed.data.reference ?? '', parsed.data)
      const text =
        start.status === 'accepted'
          ? `Native correction ${start.runId} was accepted and its first prepared batch was announced.`
          : start.result.ok
            ? `Native correction completed before native dispatch with confirmed record ${start.result.value.recordId}.`
            : `Native correction stopped before native dispatch: ${start.result.diagnostics.join(', ')}`
      return { content: [{ type: 'text', text }] }
    },
  })
  for (const { name, skill = name, description, requires } of SKILL_COMMANDS) {
    if (name === 'feature') {
      pi.registerCommand(name, {
        description,
        handler: async (args, ctx) => {
          if (!rootContext(ctx)) return
          const controller = reviewControllerFor(pi)
          controller.observeRootContext(ctx)
          let workflow: FeatureWorkflow
          try {
            workflow = options.featureWorkflow ?? (await loadFeatureWorkflow())
          } catch (error) {
            reportFeatureTerminalStatus(
              pi,
              `feature-stopped: ${error instanceof Error ? error.message : String(error)}`,
            )
            return
          }
          await runInstalledFeatureCommand(args, {
            key: pi as object,
            cwd: ctx.cwd,
            principal: options.principalCwd?.(ctx.cwd) ?? isInstalledPrincipal(ctx.cwd),
            workflow,
            native: createNativeReviewPort(pi, controller),
            send: async (message) => {
              reportFeatureTerminalStatus(pi, message)
            },
            inhibitFeatureContinuation: () => controller.inhibitFeatureContinuation(),
            releaseFeatureContinuation: () => controller.releaseFeatureContinuation(),
            featureContinuationInhibited: () => controller.featureContinuationInhibited(),
            markFeatureBatch: (batch) => controller.markFeatureBatch(batch),
            interruptOwnedWork: interruptOwnedFeatureWork,
            startReview: (reviewArgs, onComplete) =>
              dispatchDefaultReview(pi, ctx, reviewArgs, onComplete, options.prepareReview),
            prepareEpicRangeReview: (review, onComplete) => prepareInstalledEpicRangeReview(pi, review, onComplete),

            exec: (command, args, options) => pi.exec(command, args, options),
            startFix:
              options.startFeatureFix ??
              (async (reference: string) => {
                const started = await dispatchDefaultFix(pi, ctx, reference)
                const owned = ownedFixRuns.get(pi as object)
                if (owned === undefined) {
                  return {
                    terminal: Promise.resolve(
                      started.status === 'accepted'
                        ? { status: 'stopped' as const, diagnostics: ['fix-run-unavailable'] }
                        : started.result.ok
                          ? {
                              status: 'complete' as const,
                              recordId: started.result.value.recordId,
                              kind: 'fix-result' as const,
                            }
                          : { status: 'stopped' as const, diagnostics: started.result.diagnostics },
                    ),
                  }
                }
                return { terminal: owned.run.terminal }
              }),
            startAdmittedCiCorrection: async (input) => {
              const run = await dispatchAdmittedCiCorrection(pi, ctx, input)
              return { terminal: run.terminal }
            },
          })
        },
      })
      continue
    }
    if (name === 'dev-review') {
      pi.registerCommand(name, {
        description,
        handler: async (args, ctx) => dispatchDefaultReview(pi, ctx, args),
      })
      continue
    }
    if (name === 'fix') {
      pi.registerCommand(name, {
        description,
        handler: async (args, ctx) => {
          await dispatchDefaultFix(pi, ctx, args)
        },
      })
      continue
    }
    const skillDir = join(SKILLS_DIR, skill)
    pi.registerCommand(name, {
      description,
      handler: async (args) => {
        const skillPath = join(skillDir, 'SKILL.md')
        let raw: string
        try {
          raw = readFileSync(skillPath, 'utf8')
        } catch (error) {
          // omp catches a handler throw and reports it on a channel the operator
          // may not be watching: a partial install would produce no turn and no
          // visible error at all. Say it in the conversation, naming the path.
          pi.sendUserMessage(
            `/${name}: cannot read its own body at ${skillPath} — ${error instanceof Error ? error.message : String(error)}. Reinstall omp-build.`,
          )
          return
        }
        const missing = requires.filter((skill) => !exists(join(SKILLS_DIR, skill, 'SKILL.md')))
        const banner = missing.length
          ? `> **\`/${name}\` is partially installed**: ${missing.map((skill) => `\`${skill}\``).join(', ')} — no SKILL.md under ${SKILLS_DIR}. Every step of this body that names one of those stops there. Reinstall omp-build.\n`
          : ''
        const body = stripFrontmatter(raw).trim()
        const trimmedArgs = args.trim()
        pi.sendUserMessage(
          [banner, body, '', `[Skill directory: ${skillDir}]`, trimmedArgs ? `\n${trimmedArgs}` : ''].join('\n').trim(),
        )
      },
    })
  }

  const warnedMissingContract = new Set<string>()

  pi.on('tool_call', async (event, ctx) => {
    if (!hasProjectContract(ctx.cwd)) {
      if (!warnedMissingContract.has(ctx.cwd)) {
        warnedMissingContract.add(ctx.cwd)
        console.warn(
          `omp-build: no project contract found (looked for: ${PROJECT_CONTRACT_FILES.join(', ')}) — guards disabled`,
        )
      }
      return
    }

    if (event.toolName === 'bash') {
      const command = extractShellCommand(event.input)
      if (!command) return

      if (isBunTestBlocked(command)) {
        return {
          block: true,
          reason: BUN_TEST_DENY_REASON,
        }
      }

      if (shouldBlockPrincipalSwitch(command, ctx.cwd)) {
        return {
          block: true,
          reason: PRINCIPAL_FREEZE_REASON,
        }
      }
    }

    if (event.toolName === 'eval') {
      const verdict = evalGuard(event.input, ctx.cwd)
      if (verdict) return verdict
    }

    if (event.toolName === 'write' || event.toolName === 'edit') {
      const content = extractWriteContent(event.input)
      const violation = scanSecurityContent(content)
      if (violation) {
        return { block: true, reason: `Security check: ${violation}` }
      }
    }
  })

  // format hook + principal post-nudge: deferred. Never sendUserMessage on tool_result
  // (OMP treats that as a user turn and the agent may git-switch off the feature branch).
}
