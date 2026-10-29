import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { ompBuildStartReviewParametersJsonSchema, ompBuildStartReviewParametersSchema } from '../dist/contracts.js'
import { parseFeatureCommand, runTrustedFeatureInit } from '../roxabi/feature-command.ts'
import type {
  FeatureCommandHost,
  FeatureFixTerminal,
  FeatureReviewFix,
  FeatureWorkflow,
} from '../roxabi/feature-contract.ts'
import { runInstalledFeatureCommand } from '../roxabi/feature-entry.ts'
import { loadFeatureWorkflow } from '../roxabi/feature-loader.ts'
import type { FixStart } from '../roxabi/fix-entry-lifecycle.ts'
import type { prepareReviewInputs } from '../roxabi/review-pr-inputs.ts'
import type { TrustedHostPluginPin } from '../roxabi/uw-action-contract.ts'
import { bindHostPluginPin } from './host-plugin-pin.ts'
import { hostUwFactory, resolveFeatureUw } from './host-uw-operations.ts'
import { INSTALL_ROOT, installRootStatus, replacedInstallRootMessage } from './install-root'
import {
  type OmpBuildExtensionApi,
  ownedFixRunFor,
  reportFeatureTerminalStatus,
  reviewControllerFor,
} from './omp-controller'
import {
  beginFeatureUwOperation,
  cancelFeatureUwOperation,
  installFeatureUwOperationLifecycle,
} from './omp-feature-composition.ts'
import { rootContext } from './omp-feature-session'
import { dispatchAdmittedCiCorrection, dispatchDefaultFix } from './omp-fix-dispatch'
import { createOperatorConfirmation } from './omp-operator-confirmation.ts'
import { dispatchDefaultReview, prepareInstalledEpicRangeReview } from './omp-review-dispatch'
import { registerOmpReviewRecoveryTools } from './omp-review-recovery-tools'
import { SKILL_COMMANDS } from './omp-skill-commands.ts'
import { registerUwCommand, type UwOperationsFactory } from './omp-uw-command.ts'
import type { NativeBatchController } from './review-runtime/controller.ts'
import { createNativeReviewPort } from './review-runtime/port.ts'

export type OmpBuildExtensionOptions = {
  exists?: (path: string) => boolean
  /** Override seam for tests; installed commands default to the concrete UW backend. */
  uwOperations?: UwOperationsFactory
  /** Trusted host composition only. Not argv, env, or tool JSON. */
  pluginPin?: TrustedHostPluginPin
  installRoot?: string
  featureWorkflow?: FeatureWorkflow
  principalCwd?: (cwd: string) => boolean
  prepareReview?: typeof prepareReviewInputs
  startFeatureFix?: (input: FeatureReviewFix) => Promise<{ terminal: Promise<FeatureFixTerminal> }>
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---\n')) return markdown
  const end = markdown.indexOf('\n---\n', 4)
  if (end === -1) return markdown
  return markdown.slice(end + 5)
}

const requireFromIndex = createRequire(import.meta.url)

function hasPrincipalCwd(value: unknown): value is { isPrincipalCwd?: (cwd: string) => boolean } {
  return typeof value === 'object' && value !== null && 'isPrincipalCwd' in value
}

function isInstalledPrincipal(cwd: string): boolean {
  try {
    const freeze = requireFromIndex('../hooks/lib/principal-freeze.cjs')
    return hasPrincipalCwd(freeze) && freeze.isPrincipalCwd?.(cwd) === true
  } catch {
    return false
  }
}

function unownedFeatureFixTerminal(started: FixStart): FeatureFixTerminal {
  if (started.status === 'accepted') return { status: 'stopped', diagnostics: ['fix-run-unavailable'] }
  return started.result.ok
    ? { status: 'complete', recordId: started.result.value.recordId, kind: 'fix-result' }
    : { status: 'stopped', diagnostics: started.result.diagnostics }
}

async function startInstalledFeatureFix(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  input: FeatureReviewFix,
): Promise<{ terminal: Promise<FeatureFixTerminal> }> {
  const started = await dispatchDefaultFix(pi, ctx, '', input)
  const owned = ownedFixRunFor(pi)
  return owned === undefined
    ? { terminal: Promise.resolve(unownedFeatureFixTerminal(started)) }
    : { terminal: owned.run.terminal }
}

async function loadInstalledFeatureWorkflow(
  pi: OmpBuildExtensionApi,
  options: OmpBuildExtensionOptions,
): Promise<FeatureWorkflow | undefined> {
  try {
    return options.featureWorkflow ?? (await loadFeatureWorkflow())
  } catch (error) {
    reportFeatureTerminalStatus(pi, `feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

function createFeatureCommandHost(
  pi: OmpBuildExtensionApi,
  ctx: ExtensionContext,
  options: OmpBuildExtensionOptions,
  workflow: FeatureWorkflow,
  controller: NativeBatchController,
  interruptOwnedFeatureWork: (reason: string) => Promise<void>,
  uw: FeatureCommandHost['uw'],
): FeatureCommandHost {
  return {
    key: pi,
    cwd: ctx.cwd,
    principal: options.principalCwd?.(ctx.cwd) ?? isInstalledPrincipal(ctx.cwd),
    workflow,
    native: createNativeReviewPort(pi, controller),
    send: async (message) => reportFeatureTerminalStatus(pi, message),
    status: (message) => ctx.ui?.setStatus?.('omp-build-watch', message),
    inhibitFeatureContinuation: () => controller.inhibitFeatureContinuation(),
    releaseFeatureContinuation: () => controller.releaseFeatureContinuation(),
    featureContinuationInhibited: () => controller.featureContinuationInhibited(),
    markFeatureBatch: (batch) => controller.markFeatureBatch(batch),
    ...(uw === undefined ? {} : { uw }),
    ...(options.pluginPin === undefined ? {} : { pluginPin: options.pluginPin }),
    interruptOwnedWork: interruptOwnedFeatureWork,
    startReview: (args, onComplete) =>
      dispatchDefaultReview(pi, ctx, args, {
        onComplete,
        prepareReview: options.prepareReview,
        scopedGuard: () => !controller.featureContinuationInhibited(),
      }),
    prepareEpicRangeReview: (review, onComplete) => prepareInstalledEpicRangeReview(pi, review, onComplete),
    exec: (command, args, executionOptions) => pi.exec(command, args, executionOptions),
    startFix: options.startFeatureFix ?? ((input) => startInstalledFeatureFix(pi, ctx, input)),
    startAdmittedCiCorrection: async (input) => {
      const run = await dispatchAdmittedCiCorrection(pi, ctx, input)
      return { terminal: run.terminal }
    },
  }
}

async function runFeatureCommand(
  args: string,
  ctx: ExtensionContext,
  pi: OmpBuildExtensionApi,
  options: OmpBuildExtensionOptions,
  interruptOwnedFeatureWork: (reason: string) => Promise<void>,
): Promise<void> {
  if (!rootContext(ctx)) return
  const parsed = parseFeatureCommand(args)
  if (!parsed.ok) {
    reportFeatureTerminalStatus(pi, `feature-stopped: ${parsed.reason}`)
    return
  }
  if (parsed.control === 'init') {
    await runTrustedFeatureInit(parsed.args, {
      cwd: ctx.cwd,
      send: async (message) => reportFeatureTerminalStatus(pi, message),
      exec: (command, commandArgs, executionOptions) => pi.exec(command, commandArgs, executionOptions),
    })
    return
  }
  const controller = reviewControllerFor(pi)
  controller.observeRootContext(ctx)
  const workflow = await loadInstalledFeatureWorkflow(pi, options)
  if (workflow === undefined) return
  const operator = beginFeatureUwOperation(pi, createOperatorConfirmation(ctx))
  let uw: FeatureCommandHost['uw']
  if (parsed.control !== 'pause' && parsed.control !== 'abandon' && options.featureWorkflow === undefined) {
    try {
      uw = await resolveFeatureUw(ctx, operator, options.uwOperations, options.pluginPin)
    } catch (error) {
      cancelFeatureUwOperation(pi)
      throw error
    }
  }
  try {
    await runInstalledFeatureCommand(
      args,
      createFeatureCommandHost(pi, ctx, options, workflow, controller, interruptOwnedFeatureWork, uw),
    )
  } catch (error) {
    cancelFeatureUwOperation(pi)
    throw error
  }
}

function readSkillBody(
  pi: OmpBuildExtensionApi,
  name: string,
  skillPath: string,
  installRoot: string,
  exists: (path: string) => boolean,
): string | undefined {
  const install = installRootStatus(installRoot, exists)
  if (!install.present) {
    pi.sendUserMessage(`/${name}: ${replacedInstallRootMessage(install.root, install.version)}`)
    return undefined
  }
  try {
    return readFileSync(skillPath, 'utf8')
  } catch (error) {
    pi.sendUserMessage(
      `/${name}: cannot read its own body at ${skillPath} — ${error instanceof Error ? error.message : String(error)}. Reinstall omp-build.`,
    )
    return undefined
  }
}

function registerSkillCommand(
  pi: OmpBuildExtensionApi,
  name: string,
  skill: string,
  description: string,
  requires: readonly string[],
  installRoot: string,
  skillsDir: string,
  exists: (path: string) => boolean,
): void {
  const skillDir = join(skillsDir, skill)
  pi.registerCommand(name, {
    description,
    handler: async (args) => {
      const raw = readSkillBody(pi, name, join(skillDir, 'SKILL.md'), installRoot, exists)
      if (raw === undefined) return
      const missing = requires.filter((requiredSkill) => !exists(join(skillsDir, requiredSkill, 'SKILL.md')))
      const banner = missing.length
        ? `> **\`/${name}\` is partially installed**: ${missing.map((requiredSkill) => `\`${requiredSkill}\``).join(', ')} — no SKILL.md under ${skillsDir}. Every step of this body that names one of those stops there. Reinstall omp-build.\n`
        : ''
      const body = stripFrontmatter(raw).trim()
      const trimmedArgs = args.trim()
      pi.sendUserMessage(
        [banner, body, '', `[Skill directory: ${skillDir}]`, trimmedArgs ? `\n${trimmedArgs}` : ''].join('\n').trim(),
      )
    },
  })
}

export function registerOmpCommandsAndTools(
  pi: OmpBuildExtensionApi,
  options: OmpBuildExtensionOptions,
  interruptOwnedFeatureWork: (reason: string) => Promise<void>,
): void {
  bindHostPluginPin(options.pluginPin)
  const installRoot = options.installRoot ?? INSTALL_ROOT
  const skillsDir = join(installRoot, 'skills')
  const exists = options.exists ?? existsSync
  installFeatureUwOperationLifecycle(pi)
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
  registerOmpReviewRecoveryTools(pi, options)

  registerUwCommand(pi, options.uwOperations ?? hostUwFactory(options.pluginPin))

  for (const { name, skill = name, description, requires } of SKILL_COMMANDS) {
    if (name === 'feature') {
      pi.registerCommand(name, {
        description,
        handler: (args, ctx) => runFeatureCommand(args, ctx, pi, options, interruptOwnedFeatureWork),
      })
      continue
    }
    if (name === 'dev-review') {
      pi.registerCommand(name, { description, handler: async (args, ctx) => dispatchDefaultReview(pi, ctx, args) })
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
    registerSkillCommand(pi, name, skill, description, requires, installRoot, skillsDir, exists)
  }
}
