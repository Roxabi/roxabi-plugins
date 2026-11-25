import type { Scope } from '../engine/record-values.ts'
import type { UwOperations } from './uw-contract.ts'

export type DurableUwCommand =
  | { kind: 'evidence'; repository: string; number: number }
  | { kind: 'verdicts'; repository: string; number: number }

function issueReference(value: string): { repository: string; number: number } | null {
  const match = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value)
  const repository = match?.[1]
  const number = Number(match?.[2])
  return repository === undefined || !Number.isSafeInteger(number) ? null : { repository, number }
}

export function parseDurableUwCommand(command: string | undefined, tokens: readonly string[]): DurableUwCommand | null {
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
): Promise<{ kind: 'result'; value: unknown }> {
  const read = await operations.readDelivery(scopeOf(command.repository, command.number))
  if (!read.ok) return { kind: 'result', value: read }
  return { kind: 'result', value: command.kind === 'evidence' ? read.value.declarations : read.value.verdicts }
}
