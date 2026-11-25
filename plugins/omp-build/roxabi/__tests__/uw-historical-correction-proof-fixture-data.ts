import { decodeHistory } from '../../adapters/github/history-codec.ts'
import type { ActionInputs } from '../../engine/action-input-schema.ts'
import { CRITERION_EVIDENCE_FORMAT } from '../../engine/criterion-evidence-schema.ts'
import { FINDING_TARGET_FORMAT } from '../../engine/finding-target-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { NATIVE_AUTHOR } from '../../testing/record-builders.ts'
import { historicalRecordFrames, observedComment } from '../../testing/record-history.ts'

export function correctionProofHistory(scope: Scope, records: readonly CanonicalRecord[]) {
  const comments = records
    .flatMap((record) => historicalRecordFrames(record))
    .map((body, index) => {
      const nativeId = String(index + 100)
      return observedComment({ locator: `${scope.target}:${nativeId}`, nativeId, body })
    })
  return decodeHistory({
    scope,
    expectedAuthor: NATIVE_AUTHOR,
    stopAuthor: null,
    complete: true,
    comments,
    diagnostics: [],
  })
}

export function proofData(
  spec: Extract<ActionInputs['manifest']['spec'], { kind: 'accepted' }>,
  code: { repository: string; commit: string },
) {
  const target = {
    format: FINDING_TARGET_FORMAT,
    kind: 'criterion' as const,
    spec: spec.effective.own,
    id: 'C1' as const,
  }
  const toolCallId = 'historical-region-command'
  const command = 'bun test region.test.ts'
  const git = { ...code, tree: 'e'.repeat(40) }
  const run = {
    toolCallId,
    command,
    exitCode: 0,
    output: { kind: 'combined' as const, text: 'PASS region survives reload' },
    context: { probeCwd: '/fictional/worktree', start: git, end: git },
  }
  const actionId = 'historical-region-apply'
  const childId = 'historical-region-child'
  const provenance = { kind: 'native' as const, actionId, childId, submissionIndex: 0, toolCallIds: [toolCallId] }
  const scenario = 'the selected region survives reload'
  const versionClaim = { code, reason: 'Verified on the applied correction commit', references: [] }
  const receipt = {
    target,
    verification: 'evidence' as const,
    evidence: [
      {
        format: CRITERION_EVIDENCE_FORMAT,
        id: 'region-proof',
        target,
        code,
        provenance,
        method: 'test' as const,
        scenario,
        after: { run, versionClaim },
        before: null,
      },
    ],
  }
  const data = {
    outcome: 'applied',
    commitSHAs: [code.commit],
    commands: [{ command, exitCode: 0, stdout: run.output.text, stderr: '' }],
    proofPaths: ['region.test.ts'],
    guardInventory: [],
    proofToolCallId: toolCallId,
    proofUnavailableReason: null,
    criteria: [
      {
        target,
        verification: 'evidence',
        evidence: [
          { id: 'region-proof', target, method: 'test', scenario, after: { toolCallId, versionClaim }, before: null },
        ],
      },
    ],
  }
  const submission = {
    attemptIndex: 0,
    data,
    raw: { toolCallId: 'historical-region-yield', executionArguments: { data } },
    partialText: null,
  }
  const native = {
    completion: 'completed' as const,
    strict: 'valid' as const,
    raw: { terminal: { id: childId, structuredOutput: { status: 'valid', data } } },
    observation: { actionId, childId, submissionIndex: 0, submission },
    commandProvenance: provenance,
    commandRuns: [run],
    bashCalls: [
      {
        toolCallId,
        input: { command },
        effectiveCwd: run.context.probeCwd,
        result: { output: run.output.text },
        exitCode: run.exitCode,
      },
    ],
  }
  return { receipt, data, submission, native, actionId, childId }
}
