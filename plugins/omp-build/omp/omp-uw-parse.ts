import type { DurableUwCommand } from '../roxabi/uw-command-read.ts'

export type ParsedUwCommand =
  | {
      kind: 'read' | 'reports' | 'read-effective' | 'read-coverage' | 'read-completion'
      repository: string
      number: number
    }
  | { kind: 'propose' | 'write'; repository: string; number: number; proposalFile: string }
  | { kind: 'create'; repository: string; proposalFile: string }
  | { kind: 'adjudicate' | 'sister' | 'promote-report' | 'adjust-cause-dependency'; requestFile: string }
  | { kind: 'accept-material' | 'reopen' | 'abandon'; repository: string; number: number }
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

export function parseIssueCommand(
  kind:
    | 'read'
    | 'reports'
    | 'accept-material'
    | 'reopen'
    | 'abandon'
    | 'read-effective'
    | 'read-coverage'
    | 'read-completion',
  tokens: readonly string[],
): ParsedUwCommand {
  const ref = issueReference(tokens[0] ?? '')
  return ref === null || tokens.length !== 1 ? { kind: 'invalid', reason: 'uw-reference-invalid' } : { kind, ...ref }
}

export function parseProposalCommand(kind: 'propose' | 'write', tokens: readonly string[]): ParsedUwCommand {
  const ref = issueReference(tokens[0] ?? '')
  const file = proposalFile(tokens.slice(1))
  return ref === null || file === null
    ? { kind: 'invalid', reason: 'uw-proposal-file-required' }
    : { kind, ...ref, proposalFile: file }
}

export function parseCreateCommand(tokens: readonly string[]): ParsedUwCommand {
  const repository = tokens[0]
  const file = proposalFile(tokens.slice(1))
  return repository === undefined || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || file === null
    ? { kind: 'invalid', reason: 'uw-create-invalid' }
    : { kind: 'create', repository, proposalFile: file }
}
