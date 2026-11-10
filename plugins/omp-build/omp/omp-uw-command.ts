import { readFileSync } from 'node:fs'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import {
  causeAdjudicationInputSchema,
  causeDependencyAdjustmentInputSchema,
  causeSisterInputSchema,
  githubScope,
  reportPromotionInputSchema,
  uwCreateInputSchema,
  uwProposalInputSchema,
} from '../dist/contracts.js'
import { executeDurableUwCommand, parseDurableUwCommand } from '../roxabi/uw-command-read.ts'
import type { OperatorPort, UwCreateInput, UwOperations, UwProposalInput } from '../roxabi/uw-contract.ts'
import type { UwNativeHost } from '../roxabi/uw-installed-operations.ts'
import { UwGraphUnavailableError } from '../roxabi/uw-read-port.ts'
import type { OmpBuildExtensionApi } from './omp-controller.ts'
import {
  beginFeatureUwOperation,
  cancelFeatureUwOperation,
  createFeatureOperationReportGuard,
} from './omp-feature-composition.ts'
import { rootContext } from './omp-feature-session.ts'
import { createOperatorConfirmation, raceOperatorHold } from './omp-operator-confirmation.ts'
import { runNativeUwOperation } from './omp-uw-native-lifecycle.ts'
import { type ParsedUwCommand, parseCreateCommand, parseIssueCommand, parseProposalCommand } from './omp-uw-parse.ts'
import { reportResult } from './omp-uw-result.ts'
/** The operator is confirmation-only; cancelling it belongs to the owner-slot composition. */
export type UwOperationsFactory = (input: {
  cwd: string
  operator: OperatorPort
  artifactsDir: string | null
  nativeHost?: UwNativeHost
}) => Promise<UwOperations> | UwOperations

export function parseUwCommand(args: string): ParsedUwCommand {
  const [command, ...tokens] = args.trim().split(/\s+/).filter(Boolean)
  const durable = parseDurableUwCommand(command, tokens)
  if (durable !== null) return durable
  switch (command) {
    case 'read':
    case 'reports':
    case 'read-effective':
    case 'read-coverage':
    case 'read-completion':
    case 'accept-material':
    case 'reopen':
    case 'abandon':
      return parseIssueCommand(command, tokens)
    case 'propose':
    case 'write':
      return parseProposalCommand(command, tokens)
    case 'create':
      return parseCreateCommand(tokens)
    case 'adjudicate':
    case 'sister':
    case 'promote-report':
    case 'adjust-cause-dependency':
      return tokens.length === 2 && tokens[0] === '--request-file' && tokens[1]
        ? { kind: command, requestFile: tokens[1] }
        : { kind: 'invalid', reason: 'uw-request-file-required' }
    default:
      return { kind: 'invalid', reason: 'uw-command-invalid' }
  }
}

function proposal(file: string): unknown | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

type ParsedMutation = Extract<ParsedUwCommand, { kind: 'propose' | 'write' }>
type CommandOutcome = { kind: 'result'; value: unknown } | { kind: 'stopped'; reason: string }

function createInput(command: Extract<ParsedUwCommand, { kind: 'create' }>): UwCreateInput | null {
  const decoded = uwCreateInputSchema.safeParse(proposal(command.proposalFile))
  return decoded.success && decoded.data.repository === command.repository ? decoded.data : null
}

function mutationInput(command: ParsedMutation): UwProposalInput | null {
  const decoded = uwProposalInputSchema.safeParse(proposal(command.proposalFile))
  return decoded.success &&
    decoded.data.uw.repository === command.repository &&
    decoded.data.uw.target === `${command.repository}#${command.number}`
    ? decoded.data
    : null
}

async function executeMutation(command: ParsedMutation, operations: UwOperations): Promise<CommandOutcome> {
  const input = mutationInput(command)
  if (input === null) return { kind: 'stopped', reason: 'uw-proposal-invalid' }
  const value = command.kind === 'propose' ? await operations.prepare(input) : await operations.write(input)
  return { kind: 'result', value }
}

async function executeRead(repository: string, number: number, operations: UwOperations): Promise<CommandOutcome> {
  try {
    return { kind: 'result', value: await operations.readUw(githubScope(repository, number)) }
  } catch (error) {
    if (error instanceof UwGraphUnavailableError)
      return { kind: 'result', value: { status: 'refused', diagnostics: error.diagnostics } }
    throw error
  }
}

async function executeUwCommand(
  parsed: Exclude<ParsedUwCommand, { kind: 'invalid' }>,
  operations: UwOperations,
): Promise<CommandOutcome> {
  if (parsed.kind === 'action' || parsed.kind === 'evidence' || parsed.kind === 'verdicts') {
    return executeDurableUwCommand(parsed, operations)
  }
  switch (parsed.kind) {
    case 'read':
      return executeRead(parsed.repository, parsed.number, operations)
    case 'read-effective':
      return { kind: 'result', value: await operations.readEffective(githubScope(parsed.repository, parsed.number)) }
    case 'read-coverage':
      return { kind: 'result', value: await operations.readCoverage(githubScope(parsed.repository, parsed.number)) }
    case 'read-completion':
      return { kind: 'result', value: await operations.readCompletion(githubScope(parsed.repository, parsed.number)) }
    case 'reopen':
      return { kind: 'result', value: await operations.reopen(githubScope(parsed.repository, parsed.number)) }
    case 'abandon':
      return { kind: 'result', value: await operations.abandon(githubScope(parsed.repository, parsed.number)) }
    case 'reports':
      return { kind: 'result', value: await operations.listReports(githubScope(parsed.repository, parsed.number)) }
    case 'adjudicate': {
      const input = causeAdjudicationInputSchema.safeParse(proposal(parsed.requestFile))
      return input.success
        ? { kind: 'result', value: await operations.adjudicateCause(input.data) }
        : { kind: 'stopped', reason: 'uw-request-invalid' }
    }
    case 'sister': {
      const input = causeSisterInputSchema.safeParse(proposal(parsed.requestFile))
      return input.success
        ? { kind: 'result', value: await operations.createSister(input.data) }
        : { kind: 'stopped', reason: 'uw-request-invalid' }
    }
    case 'promote-report': {
      const input = reportPromotionInputSchema.safeParse(proposal(parsed.requestFile))
      return input.success
        ? { kind: 'result', value: await operations.promoteReport(input.data) }
        : { kind: 'stopped', reason: 'uw-request-invalid' }
    }
    case 'adjust-cause-dependency': {
      const input = causeDependencyAdjustmentInputSchema.safeParse(proposal(parsed.requestFile))
      return input.success
        ? { kind: 'result', value: await operations.adjustCauseDependency(input.data) }
        : { kind: 'stopped', reason: 'uw-request-invalid' }
    }
    case 'accept-material':
      return { kind: 'result', value: await operations.acceptMaterial(githubScope(parsed.repository, parsed.number)) }
    case 'create': {
      const input = createInput(parsed)
      return input === null
        ? { kind: 'stopped', reason: 'uw-proposal-invalid' }
        : { kind: 'result', value: await operations.create(input) }
    }
    case 'propose':
    case 'write':
      return executeMutation(parsed, operations)
  }
}

function reportOutcome(pi: OmpBuildExtensionApi, ctx: ExtensionContext, outcome: CommandOutcome): void {
  if (outcome.kind === 'result') reportResult(pi, ctx, outcome.value)
  else pi.sendMessage(`uw-stopped: ${outcome.reason}`, { triggerTurn: false })
}

function sameCommand(ctx: ExtensionContext, cwd: string, sessionId: string | undefined): boolean {
  if (ctx.cwd !== cwd) return false
  try {
    return ctx.sessionManager?.getSessionId() === sessionId
  } catch {
    return false
  }
}

export function registerUwCommand(pi: OmpBuildExtensionApi, factory: UwOperationsFactory): void {
  pi.registerCommand('uw', {
    description: 'Read, prepare, confirm, write, create, or accept one own UW Spec.',
    handler: async (args, ctx: ExtensionContext) => {
      const parsed = parseUwCommand(args)
      if (parsed.kind === 'invalid') {
        pi.sendMessage(`uw-stopped: ${parsed.reason}`, { triggerTurn: false })
        return
      }
      const privateOperator = createOperatorConfirmation(ctx)
      privateOperator.progress('Preparing UW operation')
      const cwd = ctx.cwd
      let sessionId: string | undefined
      try {
        sessionId = ctx.sessionManager?.getSessionId()
      } catch {
        sessionId = undefined
      }
      const ownsRootCapability = rootContext(ctx)
      if (ownsRootCapability && (parsed.kind === 'sister' || parsed.kind === 'promote-report')) {
        await runNativeUwOperation(pi, ctx, privateOperator, async (operator, nativeHost) => {
          const operations = await factory({
            cwd: ctx.cwd,
            operator,
            artifactsDir: ctx.localProtocolOptions?.getArtifactsDir?.() ?? null,
            nativeHost,
          })
          const outcome = await executeUwCommand(parsed, operations)
          if (!nativeHost.signal.aborted && sameCommand(ctx, cwd, sessionId)) reportOutcome(pi, ctx, outcome)
        })
        return
      }
      const operator = ownsRootCapability ? beginFeatureUwOperation(pi, privateOperator) : privateOperator
      const reporting = ownsRootCapability ? createFeatureOperationReportGuard(pi, ctx, operator) : null
      const isCurrent = reporting?.isCurrent ?? (() => sameCommand(ctx, cwd, sessionId))
      const captureFailure = reporting?.captureFailure ?? (() => isCurrent)
      let canReportFailure = () => false
      const work = (async () => {
        try {
          const outcome = await executeUwCommand(
            parsed,
            await factory({
              cwd: ctx.cwd,
              operator,
              artifactsDir: ctx.localProtocolOptions?.getArtifactsDir?.() ?? null,
            }),
          )
          if (isCurrent()) reportOutcome(pi, ctx, outcome)
        } catch (error) {
          canReportFailure = captureFailure()
          throw error
        } finally {
          if (ownsRootCapability) cancelFeatureUwOperation(pi, operator)
          else operator.cancel()
        }
      })()
      await raceOperatorHold(work, privateOperator.held, (error) => {
        if (!canReportFailure()) return
        pi.sendMessage(`uw-stopped: ${error instanceof Error ? error.message : String(error)}`, {
          triggerTurn: false,
        })
      })
    },
  })
}
