import { publishMissingBodies } from '../../adapters/github/publication-writer.ts'
import { type PublicationFailure, publicationFailure } from '../../adapters/github/publisher-validation.ts'
import { diagnostic, type GitHubOptions } from '../../adapters/github/types.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { startResolution } from '../../engine/workflow-action-interruption.ts'
import type { NativeBatchResult } from '../../omp/review-runtime/contracts.ts'
import type { Contracts, History } from '../feature-engine.ts'
import type { ImplementationResultBinding } from '../feature-result-binding.ts'

const scope = { repository: 'acme/app', target: 'acme/app#42' }
export const finalPublicationTip = 'a'.repeat(40)
export const finalPublicationBranch = 'feat/42-save'
export const finalPublicationBody = 'omp-build-admitted-positive-final'
export const finalPublicationPriorBody = 'omp-build-already-present-final'
export const finalPublicationSecondBody = 'omp-build-admitted-positive-final-part-2'

type ProbeClaims = {
  ids: ReadonlySet<string>
  reason: string
  criteria: []
  commands: { toolCallId: string; command: string; exitCode: number }[]
}
type ProbeAdmission = {
  commits: string[]
  paths: string[]
  commands: { toolCallId: string; command: string; exitCode: number; cwd: string }[]
  reason: string
}

export type FinalPublicationProbe = {
  live: () => boolean
  setLive: (value: boolean) => void
  awaitPublisherPrep: () => Promise<void>
  releasePublisherPrep: () => void
  admittedPositivePosts: () => number
  retainedDrafts: () => readonly CanonicalRecord[]
  seedDecodedResultReceipt: () => void
  forceUncertainAfterPost: () => void
  armWriteStartedOwnershipRevoke: () => void
  /** Two bodies; first Gh POST succeeds then live=false; second hits real writer gate. */
  armMultipartPostThenRevoke: () => void
  binding: ImplementationResultBinding
  input: {
    cwd: string
    result: NativeBatchResult
    start: { scope: typeof scope; recordId: string; kind: 'action-receipt' }
    current: () => boolean
  }
  claims: ProbeClaims
  commits: { sha: string; paths: string[] }[]
  admission: ProbeAdmission
  child: NonNullable<ImplementationResultBinding['child']>
  confirmedRemote: { branch: string; tip: string }
}

function emptyHistory(comments: DecodedHistory['source']['comments'] = []): DecodedHistory {
  return {
    source: { scope, expectedAuthor: 'automation', stopAuthor: null, complete: true, comments, diagnostics: [] },
    operations: [],
    diagnostics: [],
  }
}

function isAdmittedPositive(record: CanonicalRecord): boolean {
  return (
    record.kind === 'action-receipt' &&
    record.payload.phase === 'result' &&
    record.payload.action === 'implement' &&
    record.payload.admission?.admitted === true &&
    record.payload.admission.published === true
  )
}

function confirmed(record: CanonicalRecord) {
  return {
    status: 'confirmed' as const,
    operation: {
      operationId: record.operationId,
      recordId: record.recordId,
      kind: record.kind,
      status: 'complete' as const,
      parts: [],
      record,
      claimedKinds: [record.kind],
      authority: 'authority' as const,
    },
  }
}

function postedComment(id: number, body: string) {
  return JSON.stringify({
    id,
    body,
    user: { login: 'automation' },
    created_at: '2026-10-21T00:00:00Z',
    updated_at: '2026-10-21T00:00:00Z',
  })
}

/** Real publication-writer gate; retention writes stay ungated. */
export function createFinalPublicationProbe(args?: { startLive?: boolean }): FinalPublicationProbe {
  let live = args?.startLive ?? true
  let admittedPositivePosts = 0
  let uncertainAfterPost = false
  let bodies: readonly string[] = [finalPublicationBody]
  let current = emptyHistory()
  let multipartPostThenRevoke = false
  const retainedDrafts: CanonicalRecord[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const history = emptyHistory() as History
  const child = {
    id: 'child',
    expectedId: 'child',
    submissions: [],
    proofEvidence: null,
    raw: { exitCode: 0, structuredOutput: null },
    partialText: null,
    structured: {
      outcome: 'implemented',
      commitSHAs: [finalPublicationTip],
      commands: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0 }],
      criteria: [],
      reason: 'done',
    },
    usable: true,
    reason: null,
  }
  const commands = [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0, cwd: '/checkout' }]
  const loaded = {
    buildRecord: (draft: Omit<CanonicalRecord, 'inputs'>) => ({
      ok: true as const,
      value: { ...draft, inputs: [] } as CanonicalRecord,
    }),
    publishConfirmedWorkflowRecord: async (
      record: CanonicalRecord,
      options: GitHubOptions,
    ): Promise<ReturnType<typeof confirmed> | PublicationFailure> => {
      if (!isAdmittedPositive(record)) {
        retainedDrafts.push(record)
        return confirmed(record)
      }
      entered.resolve()
      await release.promise
      const written = await publishMissingBodies(
        record,
        bodies,
        current,
        options,
        'automation',
        'automation',
        options.stopAuthor ?? null,
      )
      if (written !== null) {
        // This fixture never drives reconcileFailedPost recovery; do not mint confirmed.
        if (written.status === 'recovered') throw new Error('fixture-publication-recovery-unsupported')
        return written
      }
      if (uncertainAfterPost) {
        live = false
        return publicationFailure('uncertain', emptyHistory(), [
          diagnostic('github-write-uncertain', 'Confirmation failed after the admitted-positive record write started'),
        ])
      }
      return confirmed(record)
    },
    readComposedWorkflowHistory: async () => ({ ok: true as const, histories: [history] }),
    startResolution,
    selectApplicableMandate: () => ({ status: 'applicable' as const, mandate: { recordId: 'mandate-1' } }),
  } as unknown as Contracts
  const binding: ImplementationResultBinding = {
    loaded,
    gh: async (_cwd, args) => {
      if (!args.includes('POST')) throw new Error(`unexpected gh request: ${args.join(' ')}`)
      admittedPositivePosts += 1
      const body = args.find((arg) => arg.startsWith('body='))?.slice(5) ?? finalPublicationBody
      if (multipartPostThenRevoke && admittedPositivePosts === 1) live = false
      return postedComment(500 + admittedPositivePosts, body)
    },
    history,
    receiptScope: scope,
    start: {
      recordId: 'start-1',
      kind: 'action-receipt',
      repository: scope.repository,
      target: scope.target,
      version: 1,
      runId: 'run-1',
      operationId: 'action-1:start',
      inputs: [],
      payload: {
        format: 'omp-build-action-receipt/2',
        phase: 'start',
        action: 'implement',
        actionId: 'action-1',
        mandate: { scope, recordId: 'mandate-1', kind: 'mandate' },
        inputs: { manifest: { deliveryData: [] } },
        exactInputs: { mandateId: 'mandate-1', planActionId: 'plan-1' },
      },
    } as never,
    mandate: { scope, recordId: 'mandate-1', kind: 'mandate' },
    branch: finalPublicationBranch,
    exactInputs: { mandateId: 'mandate-1', planActionId: 'plan-1' },
    publicationParents: [],
    child: child as never,
  }
  const result: NativeBatchResult = {
    batch: {
      operationId: 'action-1',
      tasks: {
        context: '',
        tasks: [
          {
            name: 'child',
            agent: 'R-workflow-implement',
            task: '',
            solutionSpace: '',
            action: { inputs: { manifest: { purpose: 'implement' } } } as never,
          },
        ],
      },
    },
    children: [child as never],
    raw: null,
    complete: true,
  }
  return {
    live: () => live,
    setLive: (value) => {
      live = value
    },
    awaitPublisherPrep: () => entered.promise,
    releasePublisherPrep: () => release.resolve(),
    admittedPositivePosts: () => admittedPositivePosts,
    retainedDrafts: () => retainedDrafts,
    seedDecodedResultReceipt: () => {
      // Fence keys only kind/phase/actionId; startResolution ignores non-resolution ops.
      history.operations.push({
        operationId: 'action-1:result',
        recordId: 'result-visible-1',
        kind: 'action-receipt',
        status: 'complete',
        parts: [],
        claimedKinds: ['action-receipt'],
        authority: 'authority',
        record: {
          kind: 'action-receipt',
          payload: { phase: 'result', action: 'implement', actionId: 'action-1' },
        } as never,
      })
    },
    forceUncertainAfterPost: () => {
      uncertainAfterPost = true
    },
    armWriteStartedOwnershipRevoke: () => {
      bodies = [finalPublicationPriorBody, finalPublicationBody]
      current = emptyHistory([
        {
          locator: 'comment-prior',
          nativeId: '100',
          body: finalPublicationPriorBody,
          author: 'automation',
          createdAt: '2026-10-21T00:00:00Z',
          updatedAt: '2026-10-21T00:00:00Z',
        },
      ])
    },
    armMultipartPostThenRevoke: () => {
      multipartPostThenRevoke = true
      bodies = [finalPublicationBody, finalPublicationSecondBody]
    },
    binding,
    input: {
      cwd: '/checkout',
      result,
      start: { scope, recordId: 'start-1', kind: 'action-receipt' },
      current: () => live,
    },
    claims: {
      ids: new Set(['tool-1']),
      reason: 'done',
      criteria: [],
      commands: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0 }],
    },
    commits: [{ sha: finalPublicationTip, paths: ['file.ts'] }],
    admission: { commits: [finalPublicationTip], paths: ['file.ts'], commands, reason: 'done' },
    child: child as never,
    confirmedRemote: { branch: finalPublicationBranch, tip: finalPublicationTip },
  }
}
