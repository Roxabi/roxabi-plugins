import type { NativeChildResult } from '../omp/review-runtime/contracts.ts'
import { implementNativeOutcome } from './feature-native-outcome.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type ClaimedCommand = { toolCallId: string; command: string; exitCode: number }

export function claimedToolCallIds(child: NativeChildResult | undefined): {
  ids: Set<string>
  reason: string | null
  proofToolCallId: string | null
  commands: ClaimedCommand[]
} {
  const claim = child !== undefined && isRecord(child.structured) ? child.structured : null
  const ids = claimedCommandIds(claim)
  const commands = claimedCommands(claim)
  const proofToolCallId =
    claim !== null && typeof claim.proofToolCallId === 'string' && claim.proofToolCallId.length > 0
      ? claim.proofToolCallId
      : null
  if (proofToolCallId !== null) ids.add(proofToolCallId)
  return {
    ids,
    reason: claim !== null && typeof claim.reason === 'string' ? claim.reason : null,
    proofToolCallId,
    commands,
  }
}

function claimedCommandIds(claim: Record<string, unknown> | null): Set<string> {
  const ids = new Set<string>()
  if (!Array.isArray(claim?.commands)) return ids
  for (const command of claim.commands) {
    if (isRecord(command) && typeof command.toolCallId === 'string' && command.toolCallId.length > 0) {
      ids.add(command.toolCallId)
    }
  }
  return ids
}

function claimedCommands(claim: Record<string, unknown> | null): ClaimedCommand[] {
  if (!Array.isArray(claim?.commands)) return []
  const commands: ClaimedCommand[] = []
  for (const command of claim.commands) {
    if (
      isRecord(command) &&
      typeof command.toolCallId === 'string' &&
      command.toolCallId.length > 0 &&
      typeof command.command === 'string' &&
      typeof command.exitCode === 'number' &&
      Number.isInteger(command.exitCode)
    ) {
      commands.push({ toolCallId: command.toolCallId, command: command.command, exitCode: command.exitCode })
    }
  }
  return commands
}

export function refusedImplementationPayload(input: {
  child: NativeChildResult
  complete: boolean
  claimedIds: ReadonlySet<string>
  reason: string
  commits: readonly { sha: string; paths?: readonly string[] }[]
  commands: readonly { toolCallId: string; command: string; exitCode: number; cwd: string }[]
  structuredCommands: readonly { toolCallId: string; command: string; exitCode: number }[]
  modelReason: string | null
}) {
  return {
    native: implementNativeOutcome(input.child, input.complete, input.claimedIds),
    admission: {
      admitted: false,
      commits: input.commits.map((commit) => commit.sha),
      paths: input.commits.flatMap((commit) => commit.paths ?? []),
      commands: input.commands,
      remoteBranch: null,
      remoteTip: null,
      published: false,
      reason: input.reason,
    },
    structured: {
      outcome: 'blocked' as const,
      commitSHAs: input.commits.map((commit) => commit.sha),
      commands: input.structuredCommands,
      proofToolCallId: null,
      proofUnavailableReason: input.reason,
      reason: input.modelReason ?? input.reason,
    },
    diagnostics: [{ code: input.reason, message: input.reason }],
  }
}
