import { readFileSync } from 'node:fs'
import { actionInputDigest } from '../engine/action-input.ts'
import type { NativeBatch, NativeBatchResult } from '../omp/review-runtime/contracts.js'
import { fixturePreparedAction, fixtureUwOperations } from '../testing/action-input-fixtures.ts'
import { decision } from '../testing/record-decisions.ts'
import type {
  CorrectionActionBinding,
  CorrectionEffectResult,
  ManifestedStageRecord,
  NativeCorrectionPort,
} from './correction-execution-contract'
import { createNativeCorrectionExecution } from './correction-native-execution'
import type { Continuation, Workspace } from './correction-native-execution.fixture-world'
import { cause } from './correction-native-execution.fixture-world'
import { sealActionSnapshot } from './uw-action-snapshot.ts'
import type { UwOperations } from './uw-contract.ts'

function correctionFixtureOperations(): UwOperations {
  return {
    ...fixtureUwOperations(async (request) => {
      const prepared = fixturePreparedAction(request.actionId)
      const manifest = {
        ...prepared.inputs.manifest,
        purpose: request.purpose,
        subject: request.subject,
        code: request.code,
        expandedContext: [...request.expandedContext],
      }
      const inputs = {
        ...prepared.inputs,
        manifest,
        fingerprint: actionInputDigest(manifest),
        stageSources: [...request.stageSources],
      }
      const snapshot = sealActionSnapshot(
        { ...prepared.snapshot, actionId: request.actionId, manifestDigest: inputs.fingerprint },
        [{ path: 'index.md', bytes: readFileSync(prepared.snapshot.indexPath) }],
      )
      if (!snapshot.ok) return snapshot
      return { ok: true, value: { inputs, snapshot: snapshot.value } }
    }),
    replayActionInputs: async ({ reviewed }) => ({ ok: true as const, value: reviewed }),
    verifyAction: async (snapshot) => ({ ok: true as const, value: snapshot }),
  }
}

export function executor(
  fixture: Workspace,
  port: NativeCorrectionPort,
  operation = 'operation-1',
  bindings: CorrectionActionBinding[] = [],
  conserved: NativeBatchResult[] = [],
  continuation: Continuation = { signal: new AbortController().signal },
) {
  const publishedDecision: ManifestedStageRecord = {
    repository: 'Acme/app',
    target: 'Acme/app#42',
    kind: 'decision',
    recordId: 'decision-1',
    payload: decision({
      id: 'decision-1',
      purpose: 'correction',
      causes: [cause],
      findings: [
        {
          id: 'finding-1',
          label: 'issue',
          impactReason: cause.mechanism,
          state: 'usable',
          sourceFindingIds: ['finding-1'],
          description: cause.fix,
        },
      ],
    }).payload,
  }
  return createNativeCorrectionExecution({
    native: port,
    prepared: {
      cwd: fixture.cwd,
      target: {
        repository: 'Acme/app',
        target: 'Acme/app#42',
        number: 42,
        kind: 'pull-request',
        state: 'open',
        candidateGitSHA: fixture.head,
        baseGitSHA: fixture.base,
      },
      publishBinding: fixture.binding,
      subject: { kind: 'standalone-pr', pullRequest: { repository: 'Acme/app', target: 'Acme/app#42' } },
    },
    operationId: operation,
    decisionId: 'decision-1',
    decision: publishedDecision,
    operations: correctionFixtureOperations(),
    signal: continuation.signal,
    authorizeContinuation: continuation.authorizeContinuation,
    async bindAction(binding): Promise<
      CorrectionEffectResult<{
        batch: NativeBatch
        conserve(
          result: NativeBatchResult,
        ): Promise<CorrectionEffectResult<{ contributionIds: string[]; records: readonly ManifestedStageRecord[] }>>
      }>
    > {
      bindings.push(binding)
      const batch: NativeBatch = {
        operationId: operation,
        tasks: { context: binding.task.task, tasks: [binding.task] },
      }
      return {
        ok: true,
        value: {
          batch,
          async conserve(result) {
            conserved.push(result)
            const task = result.batch.tasks.tasks.find((item) => item.name === binding.task.name)
            const child = result.children.find(
              (item) => item.expectedId === binding.task.name && item.id === binding.task.name,
            )
            if (task === undefined || child === undefined || child.structured === null) {
              return { ok: false, kind: 'terminal', diagnostics: ['native-contribution-identity-missing'] }
            }
            const record: ManifestedStageRecord = {
              repository: publishedDecision.repository,
              target: publishedDecision.target,
              kind: 'contribution',
              recordId: binding.task.name,
              payload: child.structured,
            }
            return { ok: true, value: { contributionIds: [record.recordId], records: [record] } }
          },
        },
      }
    },
    async onStarted() {
      return { ok: true, value: undefined }
    },
  })
}
