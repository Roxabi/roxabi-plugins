import type { z } from 'zod'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { Diagnostic, implementationCommandSchema } from './record-values.ts'
import type { Result } from './result.ts'
import type { PlanBlockerRef } from './workflow-output-schema.ts'

export type WorkflowEvidence = {
  issue: DecodedHistory
  pullRequest: DecodedHistory | null
  parents: readonly DecodedHistory[]
}
export type ActionCompletion = { status: 'not-started' | 'confirmed' | 'uncertain' | 'blocked'; evidence: Diagnostic[] }
export type PlanMacroPhase = 'needs-draft' | 'needs-review' | 'needs-amendment' | 'eligible' | 'blocked' | 'uncertain'
export type PlanMacro = {
  phase: PlanMacroPhase
  mandateId: string | null
  specDigest: string | null
  draftActionId: string | null
  reviewActionId: string | null
  amendmentActionId: string | null
  blockers: PlanBlockerRef[]
  evidence: Diagnostic[]
}

export function bindImplementationCommand(
  captures: readonly {
    toolCallId: string
    command: string
    exitCode: number
    cwd: string
    stdout?: string
    stderr?: string
  }[],
  claim: { toolCallId: string; command: string; exitCode: number; cwd: string },
): Result<z.infer<typeof implementationCommandSchema>> {
  const matches = captures.filter((capture) => capture.toolCallId === claim.toolCallId)
  const selected = matches[0]
  if (matches.length === 0 || selected === undefined)
    return fail([diagnostic('missing', 'implementation command was not captured')])
  if (matches.length > 1) return fail([diagnostic('ambiguous', 'implementation command id is repeated')])
  if (selected.command !== claim.command || selected.exitCode !== claim.exitCode || selected.cwd !== claim.cwd) {
    return fail([diagnostic('mismatch', 'implementation command text, exit, or cwd does not match the capture')])
  }
  return {
    ok: true,
    value: {
      toolCallId: selected.toolCallId,
      command: selected.command,
      exitCode: selected.exitCode,
    },
  }
}
