import { publishMissingBodies } from '../../adapters/github/publication-writer.ts'
import type { PublicationFailure } from '../../adapters/github/publisher-validation.ts'
import type { GitHubOptions } from '../../adapters/github/types.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { NativeBatchResult } from '../../omp/review-runtime/contracts.ts'
import type { Contracts, History } from '../feature-engine.ts'
import type { admitIntegration } from '../feature-integration-admission.ts'

type AdmittedIntegrationSuccess = Awaited<ReturnType<typeof admitIntegration>> & {
  admitted: true
  published: true
  remoteTip: string
}

const scope = { repository: 'acme/app', target: 'acme/app#42' }
export const integrationPublicationTip = 'a'.repeat(40)
export const integrationPublicationBody = 'omp-build-admitted-positive-integrate'
export const integrationPublicationSecondBody = 'omp-build-admitted-positive-integrate-2'

export type IntegrationFinalPublicationProbe = {
  live: () => boolean
  setLive: (value: boolean) => void
  awaitPublisherPrep: () => Promise<void>
  releasePublisherPrep: () => void
  /** Count of actual gh POST attempts for admitted-positive bodies. */
  admittedPositivePosts: () => number
  retainedDrafts: () => readonly CanonicalRecord[]
  /**
   * Request two missing bodies and revoke live ownership after the first real POST
   * so the writer returns ownership-revoked detail=write-started (not not-started).
   */
  armPartialAfterFirstBody: () => void
  context: {
    opened: {
      recordId: string
      payload: {
        action: 'integrate'
        actionId: string
        mandate: { scope: typeof scope; recordId: string; kind: 'mandate' }
        inputs: { manifest: { purpose: 'integrate' } }
        exactInputs: Record<string, never>
      }
    }
    loaded: Contracts
    history: History
    receiptScope: typeof scope
    publicationParents: []
    cwd: string
    gh: NonNullable<GitHubOptions['gh']>
  }
  result: NativeBatchResult
  start: { scope: typeof scope; recordId: string; kind: 'action-receipt' }
  current: () => boolean
  admission: AdmittedIntegrationSuccess
  structured: {
    outcome: 'integrated'
    code: { repository: string; base: string; head: string; referenceCommit: string }
    children: []
    coverage: { parent: { uw: typeof scope; version: string }; assignments: [] }
    commands: { toolCallId: string; command: string; exitCode: number }[]
    criteria: []
    reason: string
  }
}

function emptyHistory(): DecodedHistory {
  return {
    source: {
      scope,
      expectedAuthor: 'automation',
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    },
    operations: [],
    diagnostics: [],
  }
}

function isAdmittedPositive(record: CanonicalRecord): boolean {
  return (
    record.kind === 'action-receipt' &&
    record.payload.phase === 'result' &&
    record.payload.action === 'integrate' &&
    record.payload.admission !== null &&
    record.payload.admission.admitted === true &&
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

/** Real publication-writer gate around publisher preparation; retention writes stay ungated. */
export function createIntegrationFinalPublicationProbe(args?: {
  startLive?: boolean
}): IntegrationFinalPublicationProbe {
  let live = args?.startLive ?? true
  let admittedPositivePosts = 0
  let partialAfterFirstBody = false
  const retainedDrafts: CanonicalRecord[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const history = emptyHistory() as History
  const tip = integrationPublicationTip
  const structured = {
    outcome: 'integrated' as const,
    code: { repository: 'acme/app', base: tip, head: tip, referenceCommit: tip },
    children: [] as [],
    coverage: { parent: { uw: scope, version: 'b'.repeat(64) }, assignments: [] as [] },
    commands: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0 }],
    criteria: [] as [],
    reason: 'integrated and checked',
  }
  const child = {
    id: 'child',
    expectedId: 'child',
    submissions: [],
    proofEvidence: null,
    raw: { exitCode: 0, structuredOutput: { status: 'valid', data: structured } },
    partialText: null,
    structured,
    usable: true,
    reason: null,
    bashCalls: [{ toolCallId: 'tool-1', command: 'bun test', cwd: '/checkout' }],
    commandRuns: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0, cwd: '/checkout' }],
  }
  const inputs = { manifest: { purpose: 'integrate' as const } }
  const gh: NonNullable<GitHubOptions['gh']> = async (_cwd, args) => {
    if (args.includes('POST')) {
      admittedPositivePosts += 1
      const bodyArg = args.find((arg) => arg.startsWith('body='))
      const body = bodyArg?.slice('body='.length) ?? integrationPublicationBody
      if (partialAfterFirstBody && admittedPositivePosts === 1) live = false
      return JSON.stringify({
        id: 600 + admittedPositivePosts,
        body,
        user: { login: 'automation' },
        created_at: '2026-10-21T00:00:00Z',
        updated_at: '2026-10-21T00:00:00Z',
      })
    }
    throw new Error(`unexpected gh request: ${args.join(' ')}`)
  }
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
      const bodies = partialAfterFirstBody
        ? [integrationPublicationBody, integrationPublicationSecondBody]
        : [integrationPublicationBody]
      const written = await publishMissingBodies(
        record,
        bodies,
        emptyHistory(),
        options,
        'automation',
        'automation',
        options.stopAuthor ?? null,
      )
      if (written === null) return confirmed(record)
      // Controlled probe only admits confirmed writes or PublicationFailure; recovered is unsupported.
      if (written.status === 'recovered') {
        throw new Error('unexpected recovered publication in integration final-publication probe')
      }
      return written
    },
    readComposedWorkflowHistory: async () => ({ ok: true as const, histories: [history] }),
    startResolution: () => ({ ok: true as const, value: null }),
    selectApplicableMandate: () => ({ status: 'applicable' as const, mandate: { recordId: 'mandate-1' } }),
  } as unknown as Contracts
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
            action: { inputs } as never,
          },
        ],
      },
    },
    children: [child as never],
    raw: null,
    complete: true,
    canPublishContext: () => true,
  }
  const admission: AdmittedIntegrationSuccess = {
    admitted: true,
    commits: [tip],
    paths: ['fixture.txt'],
    commands: [{ toolCallId: 'tool-1', command: 'bun test', exitCode: 0, cwd: '/checkout' }],
    remoteBranch: null,
    remoteTip: tip,
    published: true,
    reason: structured.reason,
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
    armPartialAfterFirstBody: () => {
      partialAfterFirstBody = true
    },
    context: {
      opened: {
        recordId: 'start-1',
        payload: {
          action: 'integrate',
          actionId: 'action-1',
          mandate: { scope, recordId: 'mandate-1', kind: 'mandate' },
          inputs,
          exactInputs: {},
        },
      },
      loaded,
      history,
      receiptScope: scope,
      publicationParents: [],
      cwd: '/checkout',
      gh,
    },
    result,
    start: { scope, recordId: 'start-1', kind: 'action-receipt' },
    current: () => live,
    admission,
    structured,
  }
}
