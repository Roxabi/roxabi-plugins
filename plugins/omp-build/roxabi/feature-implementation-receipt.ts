import { completeCriterionDeclarations, type ObservationChild } from '../engine/criterion-declaration-completion.ts'
import type { CriterionDeclaration } from '../engine/criterion-evidence-schema.ts'

export { completeCriterionDeclarations } from '../engine/criterion-declaration-completion.ts'

import { implementationOutputSchema } from '../engine/workflow-output-schema.ts'
import type { NativeChildResult } from '../omp/review-runtime/contracts.ts'
import { implementNativeOutcome } from './feature-native-outcome.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type ClaimedCommand = { toolCallId: string; command: string; exitCode: number }

export function hostCompletedStructured(
  child: (Pick<NativeChildResult, 'structured'> & ObservationChild) | null,
): unknown {
  if (child === null || !isRecord(child.structured)) return child?.structured ?? null
  return {
    ...child.structured,
    commands: strippedCommands(child.structured.commands),
    criteria: completeCriterionDeclarations(child.structured.criteria, child),
  }
}

export function claimedToolCallIds(child: NativeChildResult | undefined): {
  ids: Set<string>
  reason: string | null
  criteria: CriterionDeclaration[]
  commands: ClaimedCommand[]
} {
  const completed = hostCompletedStructured(child ?? null)
  const claim = isRecord(completed) ? completed : null
  const ids = claimedCommandIds(claim)
  const commands = claimedCommands(claim)
  const parsed = implementationOutputSchema.safeParse(completed)
  return {
    ids,
    reason: claim !== null && typeof claim.reason === 'string' ? claim.reason : null,
    criteria: parsed.success ? [...parsed.data.criteria] : [],
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
function strippedCommands(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((command) =>
    isRecord(command) &&
    typeof command.toolCallId === 'string' &&
    typeof command.command === 'string' &&
    typeof command.exitCode === 'number' &&
    Number.isInteger(command.exitCode)
      ? { toolCallId: command.toolCallId, command: command.command, exitCode: command.exitCode }
      : command,
  )
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
      criteria: [],
      reason: input.modelReason ?? input.reason,
    },
    diagnostics: [{ code: input.reason, message: input.reason }],
  }
}
