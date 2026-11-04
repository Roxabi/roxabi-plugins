import { readFileSync } from 'node:fs'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import {
  causeAdjudicationInputSchema,
  causeSisterInputSchema,
  githubScope,
  reportPromotionInputSchema,
  uwCreateInputSchema,
  uwProposalInputSchema,
} from '../dist/contracts.js'
import { type DurableUwCommand, executeDurableUwCommand, parseDurableUwCommand } from '../roxabi/uw-command-read.ts'
import type { UwCreateInput, UwOperations, UwProposalInput } from '../roxabi/uw-contract.ts'
import { UwGraphUnavailableError } from '../roxabi/uw-read-port.ts'
import type { OmpBuildExtensionApi } from './omp-controller.ts'
import { beginFeatureUwOperation, cancelFeatureUwOperation } from './omp-feature-composition.ts'
import { rootContext } from './omp-feature-session.ts'
import { type CommandOperatorPort, createOperatorConfirmation } from './omp-operator-confirmation.ts'
import { reportResult } from './omp-uw-result.ts'
export type UwOperationsFactory = (input: {
  cwd: string
  operator: CommandOperatorPort
  artifactsDir: string | null
}) => Promise<UwOperations> | UwOperations

type ParsedUwCommand =
  | { kind: 'read' | 'reports'; repository: string; number: number }
  | { kind: 'propose' | 'write'; repository: string; number: number; proposalFile: string }
  | { kind: 'create'; repository: string; proposalFile: string }
  | { kind: 'adjudicate' | 'sister' | 'promote-report'; requestFile: string }
  | { kind: 'accept-material'; repository: string; number: number }
  | { kind: 'invalid'; reason: string }
  | DurableUwCommand

function issueReference(value: string): { repository: string; number: number } | null {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value)
  const repository = match?.[1]
  const number = Number(match?.[2])
  return repository === undefined || !Number.isSafeInteger(number) ? null : { repository, number }
}

function proposalFile(tokens: readonly string[]): string | null {
  return tokens.length === 2 && tokens[0] === '--proposal-file' && tokens[1] !== undefined && tokens[1] !== ''
    ? tokens[1]
    : null
}

function parseIssueCommand(kind: 'read' | 'reports' | 'accept-material', tokens: readonly string[]): ParsedUwCommand {
  const ref = issueReference(tokens[0] ?? '')
  return ref === null || tokens.length !== 1 ? { kind: 'invalid', reason: 'uw-reference-invalid' } : { kind, ...ref }
}

function parseProposalCommand(kind: 'propose' | 'write', tokens: readonly string[]): ParsedUwCommand {
  const ref = issueReference(tokens[0] ?? '')
  const file = proposalFile(tokens.slice(1))
  return ref === null || file === null
    ? { kind: 'invalid', reason: 'uw-proposal-file-required' }
    : { kind, ...ref, proposalFile: file }
}

function parseCreateCommand(tokens: readonly string[]): ParsedUwCommand {
  const repository = tokens[0]
  const file = proposalFile(tokens.slice(1))
  return repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || file === null
    ? { kind: 'invalid', reason: 'uw-create-invalid' }
    : { kind: 'create', repository, proposalFile: file }
}

export function parseUwCommand(args: string): ParsedUwCommand {
  const [command, ...tokens] = args.trim().split(/\s+/).filter(Boolean)
  const durable = parseDurableUwCommand(command, tokens)
  if (durable !== null) return durable
  switch (command) {
    case 'read':
    case 'reports':
    case 'accept-material':
      return parseIssueCommand(command, tokens)
    case 'propose':
    case 'write':
      return parseProposalCommand(command, tokens)
    case 'create':
      return parseCreateCommand(tokens)
    case 'adjudicate':
    case 'sister':
    case 'promote-report':
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
      const ownsRootCapability = rootContext(ctx)
      const operator = ownsRootCapability ? beginFeatureUwOperation(pi, privateOperator) : privateOperator
      try {
        reportOutcome(
          pi,
          ctx,
          await executeUwCommand(
            parsed,
            await factory({
              cwd: ctx.cwd,
              operator,
              artifactsDir: ctx.localProtocolOptions?.getArtifactsDir?.() ?? null,
            }),
          ),
        )
      } finally {
        if (ownsRootCapability) cancelFeatureUwOperation(pi, operator)
        else operator.cancel()
      }
    },
  })
}
