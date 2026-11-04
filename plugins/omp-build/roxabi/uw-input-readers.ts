import type { Gh } from '../adapters/github/types.ts'
import {
  actionInputsSchema,
  readCauseHistoryClosure,
  readComposedWorkflowHistory,
  recordIntegrity,
  recordOperation,
  recordsOf,
} from '../dist/contracts.js'
import type { ActionInputs, RecordInputRef } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import { readSelectedRecords } from './uw-action-basis.ts'
import { readProductionActionFactsBatch } from './uw-action-batch-facts.ts'
import type { PinnedFileRef, TrustedHostPluginPin, UwActionPorts, UwInputReadPorts } from './uw-action-contract.ts'
import { readProductionActionFacts, readSelectedRecord } from './uw-action-facts.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'
import { createActionSnapshotStore } from './uw-action-snapshot.ts'
import type { UwRead } from './uw-contract.ts'
import { correctionObservation } from './uw-correction-observation.ts'
import type { UwDeliveryReadPorts } from './uw-delivery-read.ts'
import { readGitFileBytes, readGitFileBytesBatch, readPinnedDiff } from './uw-git-bytes.ts'
import { confirmCitedRefs } from './uw-input-citations.ts'
import { readDeliveryHistories } from './uw-input-linked.ts'
import { pluginPinPort } from './uw-plugin-pin.ts'
import { discoverRepositoryReferences } from './uw-repository-refs.ts'
export type ProductionReaderOptions = {
  cwd: string
  gh: Gh
  readAuthor?: string
  pluginPin?: TrustedHostPluginPin
  artifactsDir?: string | null
}

export function createProductionInputPorts(options: ProductionReaderOptions): UwInputReadPorts {
  const source = { cwd: options.cwd, gh: options.gh, readAuthor: options.readAuthor }
  return {
    readCurrentActionFacts: (request, reviewedFingerprint, reviewedRoot) =>
      readProductionActionFacts(
        request,
        { ...source, cwd: correctionObservation(request)?.cwd ?? source.cwd },
        reviewedFingerprint,
        reviewedRoot,
      ),
    readRecord: (ref) => readSelectedRecord(ref, source),
    readRecords: (refs) => readSelectedRecords(refs, source),
    readAccountedRecord: (ref) => readSelectedRecord(ref, source, true),
    readPinnedFile: async (ref: PinnedFileRef) => {
      const bytes = await readGitFileBytes({
        repository: ref.repository,
        commit: ref.commit,
        path: ref.path,
        cwd: options.cwd,
        gh: options.gh,
      })
      if (!bytes.ok) return bytes
      if (sha256Bytes(bytes.value) !== ref.digest)
        return actionFailure('action-input-stale', `Pinned bytes changed: ${ref.repository}@${ref.commit}:${ref.path}`)
      return bytes
    },
    readPinnedFiles: async (refs) => {
      const bytes = await readGitFileBytesBatch(
        refs.map((ref) => ({
          repository: ref.repository,
          commit: ref.commit,
          path: ref.path,
          cwd: options.cwd,
          gh: options.gh,
        })),
      )
      if (!bytes.ok) return bytes
      for (const [index, ref] of refs.entries()) {
        if (sha256Bytes(bytes.value[index]) !== ref.digest)
          return actionFailure(
            'action-input-stale',
            `Pinned bytes changed: ${ref.repository}@${ref.commit}:${ref.path}`,
          )
      }
      return bytes
    },
    readCodeDiff: (code) =>
      readPinnedDiff({
        cwd: options.cwd,
        repository: code.repository,
        base: code.base,
        head: code.head,
        gh: options.gh,
      }),
    repositoryReferences: (request, plannedPaths) =>
      discoverRepositoryReferences({
        request,
        plannedPaths,
        cwd: correctionObservation(request)?.cwd ?? options.cwd,
        gh: options.gh,
      }),
    plugin: pluginPinPort({ cwd: options.cwd, gh: options.gh, trusted: options.pluginPin }),
  }
}

export function createProductionActionPorts(options: ProductionReaderOptions): UwActionPorts {
  return {
    ...createProductionInputPorts(options),
    readCurrentActionFactsBatch: (requests, reviewedFingerprint, reviewedRoot) =>
      readProductionActionFactsBatch(
        requests,
        { cwd: options.cwd, gh: options.gh, readAuthor: options.readAuthor },
        reviewedFingerprint,
        reviewedRoot,
      ),
    snapshots: createActionSnapshotStore({ artifactsDir: options.artifactsDir, cwd: options.cwd }),
  }
}
export function createProductionDeliveryPorts(
  options: ProductionReaderOptions,
  readUw: (uw: Scope) => Promise<UwRead>,
): UwDeliveryReadPorts {
  return {
    readUw,
    readDeliveryHistories: (uw) =>
      readDeliveryHistories(uw, { cwd: options.cwd, gh: options.gh, readAuthor: options.readAuthor }),
  }
}
function citedScopes(root: DecodedHistory, inputs: ActionInputs): Scope[] {
  const scopes: Scope[] = []
  const add = (scope: Scope) => {
    if (scope.repository === root.source.scope.repository && scope.target === root.source.scope.target) return
    if (scopes.some((item) => item.repository === scope.repository && item.target === scope.target)) return
    scopes.push(scope)
  }
  const subject = inputs.manifest.subject
  if (subject.kind === 'uw') {
    add(subject.uw)
    if (subject.pullRequest !== null) add(subject.pullRequest)
    if (subject.binding !== null) add(subject.binding.record.scope)
  } else add(subject.pullRequest)
  for (const ref of [...inputs.manifest.acceptedSources, ...inputs.manifest.deliveryData]) add(ref.record.scope)
  for (const ref of inputs.manifest.expandedContext) if (ref.source === 'record') add(ref.record.scope)
  return scopes
}

function citedRefs(inputs: ActionInputs): RecordInputRef[] {
  const refs = [...inputs.manifest.acceptedSources, ...inputs.manifest.deliveryData]
  for (const ref of inputs.manifest.expandedContext) if (ref.source === 'record') refs.push(ref)
  if (inputs.manifest.subject.kind === 'uw' && inputs.manifest.subject.binding !== null)
    refs.push(inputs.manifest.subject.binding)
  return refs
}

/** Root and manifest citations stay authoritative; typed causal references extend their histories. */
export async function readManifestCitedHistories(input: {
  history: DecodedHistory
  inputs: ActionInputs
  cwd: string
  gh: Gh
  readAuthor?: string
}): Promise<Result<readonly DecodedHistory[]>> {
  if (!input.history.source.complete) return actionFailure('record-unreadable', 'Root review history is incomplete')
  const scopes = citedScopes(input.history, input.inputs)
  const fetched =
    scopes.length === 0
      ? { ok: true as const, histories: [] as DecodedHistory[] }
      : await readComposedWorkflowHistory(scopes, { cwd: input.cwd, gh: input.gh, readAuthor: input.readAuthor })
  if (!fetched.ok) return { ok: false, diagnostics: fetched.diagnostics }
  const closure = await readCauseHistoryClosure([input.history, ...fetched.histories], (required) =>
    readComposedWorkflowHistory(required, { cwd: input.cwd, gh: input.gh, readAuthor: input.readAuthor }),
  )
  if (!closure.ok) return { ok: false, diagnostics: closure.diagnostics }
  const histories = closure.histories
  for (const ref of citedRefs(input.inputs)) {
    const record = histories
      .flatMap((history) => recordsOf(history))
      .find(
        (candidate) =>
          candidate.recordId === ref.record.recordId &&
          candidate.kind === ref.record.kind &&
          candidate.repository === ref.record.scope.repository &&
          candidate.target === ref.record.scope.target,
      )
    if (record === undefined)
      return actionFailure(
        'record-unreadable',
        `Cited ${ref.record.kind} ${ref.record.recordId} is absent from ${ref.record.scope.repository} ${ref.record.scope.target}`,
      )
    const operation = recordOperation(histories, record)
    if (operation === null || operation.authority !== 'accounted')
      return actionFailure(
        'record-unreadable',
        `Cited ${ref.record.kind} ${ref.record.recordId} is not an accounted native operation`,
      )
    const refusal = recordIntegrity(operation.parts, record)
    if (refusal !== null) return actionFailure(refusal.reason, refusal.detail)
  }
  return { ok: true, value: histories }
}
function assessedInputs(history: DecodedHistory): ActionInputs[] {
  const inputs: ActionInputs[] = []
  for (const record of recordsOf(history)) {
    if (record.kind !== 'review-attempt' || record.payload === null || typeof record.payload !== 'object') continue
    const parsed = actionInputsSchema.safeParse((record.payload as { inputSnapshot?: unknown }).inputSnapshot)
    if (parsed.success) inputs.push(parsed.data)
  }
  return inputs
}

/** External histories only. Union of every assessed root's cited scopes. A failed cited read is not []. */
function gatherCited(
  history: DecodedHistory,
  inputs: readonly ActionInputs[],
): { scopes: Scope[]; refs: RecordInputRef[] } {
  const scopes: Scope[] = []
  const refs: RecordInputRef[] = []
  for (const item of inputs) {
    for (const scope of citedScopes(history, item)) addScope(scopes, scope)
    refs.push(...citedRefs(item))
  }
  return { scopes, refs }
}

function addScope(scopes: Scope[], scope: Scope): void {
  if (!scopes.some((existing) => existing.repository === scope.repository && existing.target === scope.target))
    scopes.push(scope)
}

function confirmFetchedScopes(scopes: readonly Scope[], histories: readonly DecodedHistory[]): Result<true> {
  for (const scope of scopes) {
    const matched = histories.filter(
      (item) => item.source.scope.repository === scope.repository && item.source.scope.target === scope.target,
    )
    if (matched.length !== 1 || !matched[0]?.source.complete)
      return actionFailure(
        'record-unreadable',
        `Cited scope ${scope.repository} ${scope.target} is missing, conflicting, or incomplete`,
      )
  }
  return { ok: true, value: true }
}

export async function readReviewInputHistories(
  history: DecodedHistory,
  options: ProductionReaderOptions,
): Promise<Result<readonly DecodedHistory[]>> {
  if (!history.source.complete) return actionFailure('record-unreadable', 'Root review history is incomplete')
  const cited = gatherCited(history, assessedInputs(history))
  const fetched =
    cited.scopes.length === 0
      ? { ok: true as const, histories: [] as DecodedHistory[] }
      : await readComposedWorkflowHistory(cited.scopes, options)
  if (!fetched.ok) return { ok: false, diagnostics: fetched.diagnostics }
  const scopes = confirmFetchedScopes(cited.scopes, fetched.histories)
  if (!scopes.ok) return scopes
  const closure = await readCauseHistoryClosure([history, ...fetched.histories], (required) =>
    readComposedWorkflowHistory(required, options),
  )
  if (!closure.ok) return { ok: false, diagnostics: closure.diagnostics }
  const external = closure.histories.filter(
    (entry) =>
      entry.source.scope.repository !== history.source.scope.repository ||
      entry.source.scope.target !== history.source.scope.target,
  )
  const refs = confirmCitedRefs(cited.refs, history, external)
  if (!refs.ok) return refs
  return { ok: true, value: external }
}
