import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { githubScope, uwCreateInputSchema, uwProposalInputSchema } from '../dist/contracts.js'
import { type DurableUwCommand, executeDurableUwCommand, parseDurableUwCommand } from '../roxabi/uw-command-read.ts'
import type { UwCreateInput, UwOperations, UwProposalInput } from '../roxabi/uw-contract.ts'
import { UwGraphUnavailableError } from '../roxabi/uw-read-port.ts'
import type { OmpBuildExtensionApi } from './omp-controller.ts'
import { beginFeatureUwOperation, cancelFeatureUwOperation } from './omp-feature-composition.ts'
import { rootContext } from './omp-feature-session.ts'
import { type CommandOperatorPort, createOperatorConfirmation } from './omp-operator-confirmation.ts'
export type UwOperationsFactory = (input: {
  cwd: string
  operator: CommandOperatorPort
  artifactsDir: string | null
}) => Promise<UwOperations> | UwOperations

type ParsedUwCommand =
  | { kind: 'read'; repository: string; number: number }
  | { kind: 'propose' | 'write'; repository: string; number: number; proposalFile: string }
  | { kind: 'create'; repository: string; proposalFile: string }
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

function parseIssueCommand(kind: 'read' | 'accept-material', tokens: readonly string[]): ParsedUwCommand {
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
    case 'accept-material':
      return parseIssueCommand(command, tokens)
    case 'propose':
    case 'write':
      return parseProposalCommand(command, tokens)
    case 'create':
      return parseCreateCommand(tokens)
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

function text(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (item instanceof Map ? [...item.entries()] : item), 2) ?? 'null'
}

function object(value: unknown): object | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function property(value: object | null | undefined, key: string): unknown {
  return value !== null && value !== undefined && Object.hasOwn(value, key) ? Reflect.get(value, key) : undefined
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function scope(value: unknown): string | null {
  const record = object(value)
  const repository = string(property(record, 'repository'))
  const target = string(property(record, 'target'))
  return repository === null || target === null
    ? null
    : target.startsWith(`${repository}#`)
      ? target
      : `${repository}:${target}`
}

function diagnosticCodes(value: unknown): readonly string[] {
  const diagnostics = property(object(value), 'diagnostics')
  return !Array.isArray(diagnostics)
    ? []
    : diagnostics.flatMap((diagnostic) => {
        const code = string(property(object(diagnostic), 'code'))
        return code === null ? [] : [code]
      })
}

function readSummary(value: object): string {
  const proposed = object(property(value, 'proposed'))
  const proposalSnapshot = property(proposed, 'ok') === true ? object(property(proposed, 'snapshot')) : null
  const proposalSpec = object(property(proposalSnapshot, 'spec'))
  const accepted = object(property(value, 'accepted'))
  const acceptedValue = property(accepted, 'status') === 'accepted' ? object(property(accepted, 'value')) : null
  const acceptedRef = object(property(acceptedValue, 'ref'))
  const proposedVersion = string(property(proposalSpec, 'version')) ?? 'unavailable'
  const acceptedVersion =
    string(property(acceptedRef, 'version')) ?? string(property(accepted, 'status')) ?? 'unavailable'
  const blocked = [
    ...diagnosticCodes(property(object(property(value, 'admission')), 'framed')),
    ...diagnosticCodes(property(object(property(value, 'admission')), 'deliverable')),
    ...diagnosticCodes(proposed),
    ...diagnosticCodes(accepted),
  ]
  const details = blocked.length === 0 ? '' : ` diagnostics=${[...new Set(blocked)].join(',')}`
  return `uw-read: ${scope(property(value, 'uw')) ?? 'unknown'} proposed=${proposedVersion} accepted=${acceptedVersion}${details}`
}

function resultSummary(value: unknown): string {
  const record = object(value)
  if (record === null) return 'uw-result: malformed-result'
  if (Object.hasOwn(record, 'uw') && Object.hasOwn(record, 'parsed')) return readSummary(record)
  const status = string(property(record, 'status'))
  const resultValue = object(property(record, 'value'))
  if (status !== null) {
    const target = scope(property(record, 'uw')) ?? scope(property(resultValue, 'uw'))
    const diagnostics = diagnosticCodes(record)
    const suffix = diagnostics.length === 0 ? '' : ` diagnostics=${diagnostics.join(',')}`
    return `uw-${status}: ${target ?? 'no-trustworthy-uw'}${suffix}`
  }
  if (property(record, 'ok') === true && resultValue !== null) {
    const proposal = object(property(resultValue, 'proposal'))
    const target = object(property(proposal, 'target'))
    const uw = scope(property(target, 'uw')) ?? string(property(target, 'repository')) ?? 'unknown'
    const allocation = object(property(proposal, 'allocation'))
    const spec = object(property(allocation, 'spec'))
    const version = string(property(spec, 'version')) ?? 'unavailable'
    return `uw-prepared: ${uw} proposed=${version}`
  }
  const diagnostics = diagnosticCodes(record)
  return `uw-refused: ${diagnostics.length === 0 ? 'unspecified' : diagnostics.join(',')}`
}

function writeSessionResultArtifact(ctx: ExtensionContext, value: unknown): string | null {
  const directory = ctx.localProtocolOptions?.getArtifactsDir?.()
  if (directory === undefined || directory === null) return null
  try {
    mkdirSync(directory, { recursive: true })
    const last = readdirSync(directory).reduce((maximum, file) => {
      const match = /^(\d+)\./.exec(file)
      const id = match === null ? null : Number(match[1])
      return id === null || !Number.isSafeInteger(id) ? maximum : Math.max(maximum, id)
    }, -1)
    for (let id = last + 1; id <= last + 100; id += 1) {
      const path = resolve(directory, `${id}.uw-result.json`)
      try {
        writeFileSync(path, text(value), { flag: 'wx' })
        return path
      } catch (error) {
        if (string(property(object(error), 'code')) !== 'EEXIST') return null
      }
    }
  } catch {
    return null
  }
  return null
}

function reportResult(pi: OmpBuildExtensionApi, ctx: ExtensionContext, value: unknown): void {
  const path = writeSessionResultArtifact(ctx, value)
  const detail =
    path === null ? 'detail=unavailable' : `detail=${path} owner=session-artifacts lifetime=session-retention`
  pi.sendMessage(`${resultSummary(value)} ${detail}`, { triggerTurn: false })
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

async function executeUwCommand(
  parsed: Exclude<ParsedUwCommand, { kind: 'invalid' }>,
  operations: UwOperations,
): Promise<CommandOutcome> {
  if (parsed.kind === 'action' || parsed.kind === 'evidence' || parsed.kind === 'verdicts') {
    return executeDurableUwCommand(parsed, operations)
  }
  switch (parsed.kind) {
    case 'read':
      try {
        return { kind: 'result', value: await operations.readUw(githubScope(parsed.repository, parsed.number)) }
      } catch (error) {
        if (error instanceof UwGraphUnavailableError)
          return { kind: 'result', value: { status: 'refused', diagnostics: error.diagnostics } }
        throw error
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
