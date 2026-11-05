import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import {
  ACTION_BINDING_FORMAT,
  ACTION_INPUT_FORMAT,
  type ActionInputs,
  type ActionPurpose,
} from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import { createReviewClassCatalogues, type ReviewCatalogueRead } from '../engine/review-class-catalogue.ts'
import type { SpecEffective } from '../engine/spec-effective.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { mandateScope } from '../engine/workflow-control.ts'
import type { PreparedUwAction, ReviewActionBatch } from '../roxabi/uw-action-contract.ts'
import { sealActionSnapshot } from '../roxabi/uw-action-snapshot.ts'
import type { UwOperations } from '../roxabi/uw-contract.ts'
import { admitsConfirmingReviewBatchItem } from './review-batch-fixture.ts'

const SHA = 'a'.repeat(64)
const GIT = 'b'.repeat(40)
const SCOPE = { repository: 'acme/app', target: 'acme/app#42' }
const catalogueBytes = readFileSync(new URL('../skills/dev-review/review-classes.yml', import.meta.url))
const catalogueRef = {
  source: 'git-file' as const,
  repository: 'Roxabi/roxabi-plugins',
  commit: GIT,
  path: 'plugins/omp-build/skills/dev-review/review-classes.yml',
  digest: createHash('sha256').update(catalogueBytes).digest('hex'),
}

/** Respond only to this local fixture's fictional GitHub blob lookup and blob fetch. */
export function fixtureCatalogueGhResponse(args: readonly string[]): string | null {
  const oid = createHash('sha1').update(`blob ${catalogueBytes.byteLength}\0`).update(catalogueBytes).digest('hex')
  if (
    args[0] === 'api' &&
    args[1] === 'graphql' &&
    args.some((arg) => arg.includes('object(expression:$expression)')) &&
    args.includes('owner=Roxabi') &&
    args.includes('name=roxabi-plugins') &&
    args.includes(`expression=${catalogueRef.commit}:${catalogueRef.path}`)
  )
    return JSON.stringify({ data: { repository: { object: { oid } } } })
  if (args[0] === 'api' && args.includes(`repos/${catalogueRef.repository}/git/blobs/${oid}`))
    return JSON.stringify({
      sha: oid,
      encoding: 'base64',
      size: catalogueBytes.byteLength,
      content: catalogueBytes.toString('base64'),
    })
  return null
}

export function fixtureReviewCatalogueReads() {
  return [{ ref: { ...catalogueRef }, contents: { ok: true as const, value: new Uint8Array(catalogueBytes) } }]
}
/** Source-engine instance for tests supplying their own exact pinned bytes. */
export function fixtureSourceReviewClassCatalogues(reads: readonly ReviewCatalogueRead[]) {
  return createReviewClassCatalogues(reads)
}

export function fixtureReviewClassCatalogues() {
  return createReviewClassCatalogues(fixtureReviewCatalogueReads())
}

/** Explicit negative evidence: no catalogue bytes have been observed. */
export function fixtureMissingReviewClassCatalogues() {
  return createReviewClassCatalogues([])
}

export function fixtureCausal(histories: readonly DecodedHistory[]) {
  const byScope = new Map<string, DecodedHistory>()
  for (const history of histories) {
    const key = JSON.stringify([history.source.scope.repository, history.source.scope.target])
    const previous = byScope.get(key)
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(history))
      throw new Error(`Conflicting fixture histories for ${history.source.scope.target}`)
    byScope.set(key, history)
  }
  return { histories: [...byScope.values()], catalogues: fixtureReviewClassCatalogues() }
}

export function workflowEvidence(
  issue: DecodedHistory,
  pullRequest: DecodedHistory | null,
  parents: readonly DecodedHistory[],
  extraCausalHistories: readonly DecodedHistory[],
) {
  return {
    issue,
    pullRequest,
    parents,
    causal: fixtureCausal([issue, ...(pullRequest === null ? [] : [pullRequest]), ...parents, ...extraCausalHistories]),
  }
}

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
      files: [{ ...catalogueRef }],
    },
    configuration: { version: '0.15.0', digest: SHA, serialized: 'config' },
    expandedContext: [],
  }
}

export function standaloneReviewInputs(
  scope: { repository: string; target: string } = SCOPE,
  head = '1'.repeat(40),
): ActionInputs {
  const base = pin()
  const manifest = {
    ...base,
    code: { ...base.code, repository: scope.repository, head },
    purpose: 'review' as const,
    subject: { kind: 'standalone-pr' as const, pullRequest: scope },
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
    acceptedSources: [
      {
        source: 'record' as const,
        record: { scope: mandateScope(mandate), recordId: mandate.recordId, kind: 'mandate' as const },
        selector: '/payload',
        digest: canonicalValueDigest(mandate.payload),
      },
    ],
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
    listReports: unexpected,
    adjudicateCause: unexpected,
    createSister: unexpected,
    promoteReport: unexpected,
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
