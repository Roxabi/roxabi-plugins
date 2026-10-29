import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actionInputDigest } from '../engine/action-input.ts'
import {
  ACTION_BINDING_FORMAT,
  ACTION_INPUT_FORMAT,
  type ActionInputs,
  type ActionPurpose,
} from '../engine/action-input-schema.ts'
import type { Result } from '../engine/result.ts'
import type { SpecEffective } from '../engine/spec-effective.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { mandateScope } from '../engine/workflow-control.ts'
import type { PreparedUwAction, ReviewActionBatch } from '../roxabi/uw-action-contract.ts'
import { sealActionSnapshot } from '../roxabi/uw-action-snapshot.ts'
import type { UwOperations } from '../roxabi/uw-contract.ts'

const SHA = 'a'.repeat(64)
const GIT = 'b'.repeat(40)
const SCOPE = { repository: 'acme/app', target: 'acme/app#42' }

function pin() {
  return {
    format: ACTION_INPUT_FORMAT,
    code: { repository: 'acme/app', base: GIT, head: GIT, referenceCommit: GIT },
    acceptedSources: [],
    deliveryData: [],
    repositoryReferences: [],
    plugin: {
      name: 'omp-build' as const,
      version: '0.15.0',
      repository: 'Roxabi/roxabi-plugins',
      commit: GIT,
      root: 'plugins/omp-build',
      files: [],
    },
    configuration: { version: '0.15.0', digest: SHA, serialized: 'config' },
    expandedContext: [],
  }
}

export function standaloneReviewInputs(): ActionInputs {
  const base = pin()
  const manifest = {
    ...base,
    code: { ...base.code, head: '1'.repeat(40) },
    purpose: 'review' as const,
    subject: { kind: 'standalone-pr' as const, pullRequest: SCOPE },
    spec: { kind: 'absent' as const, reason: 'standalone-review' as const },
  }
  return {
    format: ACTION_BINDING_FORMAT,
    manifest,
    fingerprint: actionInputDigest(manifest),
    stageSources: [],
  }
}

/** Distinct from standaloneReviewInputs so grant digests are real fingerprints, not literals. */
export function freshReviewInputs(): ActionInputs {
  const base = standaloneReviewInputs()
  const manifest = {
    ...base.manifest,
    code: { ...base.manifest.code, head: 'c'.repeat(40) },
  }
  return { ...base, manifest, fingerprint: actionInputDigest(manifest) }
}

export function acceptedActionInputs(mandate: MandateRecord, purpose: ActionPurpose): ActionInputs {
  const own = {
    uw: mandate.payload.ownSpec.uw,
    version: mandate.payload.ownSpec.version,
    sourceAccepted: { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' as const },
  }
  const effective: SpecEffective = {
    format: 'omp-build-spec-effective/1',
    resolution: 'own-only',
    own,
    versionVector: [own],
    spec: mandate.payload.ownSpec.snapshot.spec,
    ancestry: 'not-resolved',
  }
  const manifest = {
    ...pin(),
    purpose,
    subject: { kind: 'uw' as const, uw: own.uw, pullRequest: null, binding: null },
    spec: { kind: 'accepted' as const, effective },
  }
  return {
    format: ACTION_BINDING_FORMAT,
    manifest,
    fingerprint: actionInputDigest(manifest),
    stageSources: [],
  }
}

export function fixturePreparedAction(actionId = 'action'): PreparedUwAction {
  const inputs = standaloneReviewInputs()
  const directory = join(tmpdir(), `omp-prepared-${randomUUID()}`)
  mkdirSync(directory)
  const bytes = new TextEncoder().encode(`# ${actionId}\n`)
  const indexPath = join(directory, 'index.md')
  writeFileSync(indexPath, bytes)
  const sealed = sealActionSnapshot(
    {
      id: `fixture-${actionId}`,
      actionId,
      manifestDigest: inputs.fingerprint,
      indexPath,
      location: 'local',
    },
    [{ path: 'index.md', bytes }],
  )
  if (!sealed.ok) throw new Error(sealed.diagnostics.map((item) => item.code).join(','))
  return { inputs, snapshot: sealed.value }
}

/** Closed UW port. Action methods default to refusal; unexpected calls throw. */
export function fixtureUwOperations(
  prepareAction: UwOperations['prepareAction'] = async () => ({ ok: false, diagnostics: [] }),
): UwOperations {
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected UW operation')
  }
  return {
    readUw: unexpected,
    prepare: unexpected,
    validateNormalization() {
      throw new Error('unexpected UW operation')
    },
    write: unexpected,
    create: unexpected,
    acceptMaterial: unexpected,
    prepareAction,
    prepareReviewActions: async () => ({ ok: false, diagnostics: [] }),
    replayActionInputs: async () => ({ ok: false, diagnostics: [] }),
    verifyAction: async () => ({ ok: false, diagnostics: [] }),
    readDelivery: unexpected,
  }
}

/** Prepare, replay, and verify agree, so confirmPreparedAction can succeed in fixtures. */
export function confirmingUwOperations(): UwOperations {
  const prepared = fixturePreparedAction()
  const operations: UwOperations = {
    ...fixtureUwOperations(async () => ({ ok: true, value: prepared })),
    replayActionInputs: async () => ({ ok: true, value: prepared.inputs }),
    verifyAction: async () => ({ ok: true, value: prepared.snapshot }),
    prepareReviewActions: (input) => confirmingReviewActions(operations, input),
  }
  return operations
}

function admitsConfirmingReviewBatchItem(
  item: ReviewActionBatch['actions'][number],
  index: number,
  commonRequest: string,
  commonProjection: string,
  ids: ReadonlySet<string>,
  names: ReadonlySet<string>,
): boolean {
  const panel = /^panel-(\d+)-(.+)$/.exec(item.projection.taskName)
  return (
    item.request.purpose === 'review' &&
    JSON.stringify({ ...item.request, actionId: '' }) === commonRequest &&
    JSON.stringify({ contextWindow: item.projection.contextWindow, chunks: item.projection.chunks }) ===
      commonProjection &&
    !ids.has(item.request.actionId) &&
    !names.has(item.projection.taskName) &&
    (index === 0 || (panel !== null && Number(panel[1]) === item.projection.assignedChunk))
  )
}

async function confirmDistinctReviewAction(
  operations: UwOperations,
  item: ReviewActionBatch['actions'][number],
): Promise<Result<PreparedUwAction>> {
  const existing = await operations.prepareAction(item.request, item.projection)
  if (!existing.ok) return existing
  const distinct = fixturePreparedAction(item.request.actionId)
  if (distinct.inputs.fingerprint !== existing.value.inputs.fingerprint) return { ok: false, diagnostics: [] }
  const replay = await operations.replayActionInputs({ reviewed: distinct.inputs, request: item.request })
  if (!replay.ok || replay.value.fingerprint !== distinct.inputs.fingerprint) return { ok: false, diagnostics: [] }
  const verified = await operations.verifyAction(distinct.snapshot)
  if (!verified.ok) return verified
  return { ok: true, value: distinct }
}

async function confirmingReviewActions(
  operations: UwOperations,
  input: ReviewActionBatch,
): Promise<Result<readonly PreparedUwAction[]>> {
  const first = input.actions[0]
  if (first === undefined || first.projection.taskName !== 'spec' || first.projection.assignedChunk !== null) {
    return { ok: false, diagnostics: [] }
  }
  const prepared: PreparedUwAction[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  const commonRequest = JSON.stringify({ ...first.request, actionId: '' })
  const commonProjection = JSON.stringify({
    contextWindow: first.projection.contextWindow,
    chunks: first.projection.chunks,
  })
  for (const [index, item] of input.actions.entries()) {
    if (!admitsConfirmingReviewBatchItem(item, index, commonRequest, commonProjection, ids, names)) {
      return { ok: false, diagnostics: [] }
    }
    ids.add(item.request.actionId)
    names.add(item.projection.taskName)
    const distinct = await confirmDistinctReviewAction(operations, item)
    if (!distinct.ok) return distinct
    prepared.push(distinct.value)
  }
  return { ok: true, value: prepared }
}
