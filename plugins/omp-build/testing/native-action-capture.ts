import type { CommandRun, EvidenceProvenance, GitBoundaryObservation } from '../engine/criterion-evidence-schema.ts'
import type { Json, NativeOutcome, Submission } from '../engine/record-values.ts'

/** Historical SDK terminal and raw yield, as stored by the former native runtime. */
export function historicalSubmission(childId: string, data: Json) {
  const submission: Submission = {
    attemptIndex: 0,
    data,
    raw: {
      toolCallId: `${childId}-yield`,
      contentIndex: null,
      argumentDeltas: [],
      argumentText: '',
      rawBlock: null,
      toolCallArguments: null,
      executionArguments: { data },
    },
    partialText: null,
  }
  const native = {
    completion: 'completed',
    strict: 'valid',
    raw: { id: childId, exitCode: 0, structuredOutput: { status: 'valid', data } },
  } satisfies NativeOutcome
  return { submission, native }
}

/** Seed the stored bash call and its matching criterion observation without executing the command. */
export function historicalCommandCapture(input: {
  actionId: string
  cwd: string
  childId: string
  command: string
  toolCallId: string
  output: string
  claim: Json
  git: GitBoundaryObservation
}) {
  const { actionId, childId, toolCallId, command, output, cwd, git } = input
  const { native: terminal, submission } = historicalSubmission(childId, input.claim)
  const native: NativeOutcome = {
    ...terminal,
    bashCalls: [
      {
        toolCallId,
        input: { command },
        effectiveCwd: cwd,
        result: { content: [{ type: 'text', text: output }], details: { exitCode: 0 } },
        exitCode: 0,
      },
    ],
  }
  const run: CommandRun = {
    toolCallId,
    command,
    exitCode: 0,
    output: {
      kind: 'sdk-view',
      text: output,
      source: 'native-tool-result',
      completeness: 'potentially-incomplete',
    },
    context: { probeCwd: cwd, start: git, end: git },
  }
  const nativeProvenance: EvidenceProvenance = {
    kind: 'native',
    actionId,
    childId,
    submissionIndex: submission.attemptIndex,
    toolCallIds: [toolCallId],
  }
  return { native, commandRuns: [run], nativeProvenance }
}
