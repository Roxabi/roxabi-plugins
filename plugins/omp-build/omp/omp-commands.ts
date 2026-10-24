import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { ompBuildStartReviewParametersJsonSchema, ompBuildStartReviewParametersSchema } from '../dist/contracts.js'
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
import {
  type OmpBuildExtensionApi,
  ownedFixRunFor,
  reportFeatureTerminalStatus,
  reviewControllerFor,
} from './omp-controller'
import { rootContext } from './omp-feature-session'
import { dispatchAdmittedCiCorrection, dispatchDefaultFix } from './omp-fix-dispatch'
import { dispatchDefaultReview, prepareInstalledEpicRangeReview } from './omp-review-dispatch'
import type { NativeBatchController } from './review-runtime/controller.ts'
import { createNativeReviewPort } from './review-runtime/port.ts'

const SKILLS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'skills')

/** Slash commands with a skill body; native review, correction, and feature have real host pipelines. */
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
    // The optional tail (#495). Offered after a ticket lands, never chained.
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

export type OmpBuildExtensionOptions = {
  exists?: (path: string) => boolean
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
): FeatureCommandHost {
  return {
    key: pi,
    cwd: ctx.cwd,
    principal: options.principalCwd?.(ctx.cwd) ?? isInstalledPrincipal(ctx.cwd),
    workflow,
    native: createNativeReviewPort(pi, controller),
    send: async (message) => reportFeatureTerminalStatus(pi, message),
    inhibitFeatureContinuation: () => controller.inhibitFeatureContinuation(),
    releaseFeatureContinuation: () => controller.releaseFeatureContinuation(),
    featureContinuationInhibited: () => controller.featureContinuationInhibited(),
    markFeatureBatch: (batch) => controller.markFeatureBatch(batch),
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
  const controller = reviewControllerFor(pi)
  controller.observeRootContext(ctx)
  const workflow = await loadInstalledFeatureWorkflow(pi, options)
  if (workflow === undefined) return
  await runInstalledFeatureCommand(
    args,
    createFeatureCommandHost(pi, ctx, options, workflow, controller, interruptOwnedFeatureWork),
  )
}

export function registerOmpCommandsAndTools(
  pi: OmpBuildExtensionApi,
  options: OmpBuildExtensionOptions,
  interruptOwnedFeatureWork: (reason: string) => Promise<void>,
): void {
  const { exists = existsSync } = options
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
    const skillDir = join(SKILLS_DIR, skill)
    pi.registerCommand(name, {
      description,
      handler: async (args) => {
        const skillPath = join(skillDir, 'SKILL.md')
        let raw: string
        try {
          raw = readFileSync(skillPath, 'utf8')
        } catch (error) {
          pi.sendUserMessage(
            `/${name}: cannot read its own body at ${skillPath} — ${error instanceof Error ? error.message : String(error)}. Reinstall omp-build.`,
          )
          return
        }
        const missing = requires.filter((requiredSkill) => !exists(join(SKILLS_DIR, requiredSkill, 'SKILL.md')))
        const banner = missing.length
          ? `> **\`/${name}\` is partially installed**: ${missing.map((requiredSkill) => `\`${requiredSkill}\``).join(', ')} — no SKILL.md under ${SKILLS_DIR}. Every step of this body that names one of those stops there. Reinstall omp-build.\n`
          : ''
        const body = stripFrontmatter(raw).trim()
        const trimmedArgs = args.trim()
        pi.sendUserMessage(
          [banner, body, '', `[Skill directory: ${skillDir}]`, trimmedArgs ? `\n${trimmedArgs}` : ''].join('\n').trim(),
        )
      },
    })
  }
}
