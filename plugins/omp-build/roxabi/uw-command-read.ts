import { readFileSync } from 'node:fs'
import { actionEnvelopeSchema } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { UwOperations } from './uw-contract.ts'

export type DurableUwCommand =
  | { kind: 'action'; requestFile: string }
  | { kind: 'evidence'; repository: string; number: number }
  | { kind: 'verdicts'; repository: string; number: number }

function issueReference(value: string): { repository: string; number: number } | null {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value)
  const repository = match?.[1]
  const number = Number(match?.[2])
  return repository === undefined || !Number.isSafeInteger(number) ? null : { repository, number }
}

export function parseDurableUwCommand(command: string | undefined, tokens: readonly string[]): DurableUwCommand | null {
  if (command === 'action' && tokens.length === 1 && tokens[0] !== undefined && tokens[0] !== '') {
    return { kind: 'action', requestFile: tokens[0] }
  }
  if (command === 'evidence') {
    const ref = issueReference(tokens[0] ?? '')
    return ref === null ? null : { kind: 'evidence', ...ref }
  }
  if (command === 'verdicts') {
    const ref = issueReference(tokens[0] ?? '')
    return ref === null ? null : { kind: 'verdicts', ...ref }
  }
  return null
}

function scopeOf(repository: string, number: number): Scope {
  return { repository, target: `${repository}#${number}` }
}

export async function executeDurableUwCommand(
  command: DurableUwCommand,
  operations: UwOperations,
): Promise<{ kind: 'result'; value: unknown } | { kind: 'stopped'; reason: string }> {
  if (command.kind === 'evidence' || command.kind === 'verdicts') {
    const read = await operations.readDelivery(scopeOf(command.repository, command.number))
    if (!read.ok) return { kind: 'result', value: read }
    return { kind: 'result', value: command.kind === 'evidence' ? read.value.declarations : read.value.verdicts }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(command.requestFile, 'utf8'))
  } catch {
    return { kind: 'stopped', reason: 'uw-action-invalid' }
  }
  const body = actionEnvelopeSchema.safeParse(parsed)
  if (!body.success) return { kind: 'stopped', reason: 'uw-action-invalid' }
  if (body.data.reviewed !== undefined) {
    return {
      kind: 'result',
      value: await operations.replayActionInputs({ reviewed: body.data.reviewed, request: body.data.request }),
    }
  }
  return { kind: 'result', value: await operations.prepareAction(body.data.request) }
}
