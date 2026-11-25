import type { Gh } from '../adapters/github/types.ts'
import {
  actionInputsSchema,
  readCauseHistoryClosureFromPrimary,
  readComposedWorkflowHistory,
  readUwCompletionObservation,
  recordsOf,
} from '../dist/contracts.js'
import type { ActionInputs, RecordInputRef } from '../engine/action-input-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { FramingProcedurePorts } from './feature-framing-contract.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { PinnedFileRef, TrustedHostPluginPin } from './plugin-pin-contract.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'
import type { UwDeliveryReadPorts } from './uw-delivery-read.ts'
import { readGitFileBytes } from './uw-git-bytes.ts'
import { confirmCitedRefs } from './uw-input-citations.ts'
import { pluginPinPort } from './uw-plugin-pin.ts'

type ProductionReaderOptions = { cwd: string; gh: Gh; readAuthor?: string }

export function createFramingProcedurePorts(
  options: Pick<ProductionReaderOptions, 'cwd' | 'gh'> & { pluginPin?: TrustedHostPluginPin },
): FramingProcedurePorts {
  return {
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
    plugin: pluginPinPort({ cwd: options.cwd, gh: options.gh, trusted: options.pluginPin }),
  }
}

export function createProductionDeliveryPorts(options: ProductionReaderOptions): UwDeliveryReadPorts {
  const github = withRoxabiGitHubPolicy({ cwd: options.cwd, gh: options.gh, readAuthor: options.readAuthor })
  return {
    readObservation: (uw) =>
      readUwCompletionObservation(uw, github, (histories) =>
        loadReviewClassCatalogues({ histories, cwd: options.cwd, gh: options.gh }),
      ),
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
  for (const ref of [...inputs.manifest.acceptedSources, ...inputs.manifest.deliveryData, ...inputs.stageSources])
    add(ref.record.scope)
  for (const ref of inputs.manifest.expandedContext) if (ref.source === 'record') add(ref.record.scope)
  return scopes
}

function citedRefs(inputs: ActionInputs): RecordInputRef[] {
  const refs = [...inputs.manifest.acceptedSources, ...inputs.manifest.deliveryData, ...inputs.stageSources]
  for (const ref of inputs.manifest.expandedContext) if (ref.source === 'record') refs.push(ref)
  if (inputs.manifest.subject.kind === 'uw' && inputs.manifest.subject.binding !== null)
    refs.push(inputs.manifest.subject.binding)
  return refs
}

function assessedInputs(history: DecodedHistory): ActionInputs[] {
  const inputs: ActionInputs[] = []
  const add = (value: unknown) => {
    const parsed = actionInputsSchema.safeParse(value)
    if (parsed.success) inputs.push(parsed.data)
  }
  for (const record of recordsOf(history)) addAssessedRecord(record, add)
  return inputs
}

function addAssessedRecord(record: ReturnType<typeof recordsOf>[number], add: (value: unknown) => void): void {
  if (record.kind === 'review-attempt') {
    if ('inputSnapshot' in record.payload) add(record.payload.inputSnapshot)
    addAssessedSlots(record.payload.slots, add)
  } else if (record.kind === 'contribution') {
    if (record.payload.host.action !== undefined) add(record.payload.host.action.inputs)
  } else if (record.kind === 'action-receipt') {
    add(record.payload.inputs)
    if ('slots' in record.payload) addAssessedSlots(record.payload.slots, add)
  }
}

function addAssessedSlots(slots: readonly { action?: { inputs: unknown } }[], add: (value: unknown) => void): void {
  for (const slot of slots) if (slot.action !== undefined) add(slot.action.inputs)
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
    for (const ref of citedRefs(item)) {
      if (
        ref.record.scope.repository !== history.source.scope.repository ||
        ref.record.scope.target !== history.source.scope.target
      )
        refs.push(ref)
    }
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
  additionalScopes: readonly Scope[] = [],
): Promise<Result<readonly DecodedHistory[]>> {
  const cited = gatherCited(history, assessedInputs(history))
  for (const scope of additionalScopes) {
    if (scope.repository !== history.source.scope.repository || scope.target !== history.source.scope.target)
      addScope(cited.scopes, scope)
  }
  const fetched =
    cited.scopes.length === 0
      ? { ok: true as const, histories: [] as DecodedHistory[] }
      : await readComposedWorkflowHistory(cited.scopes, options, [history])
  if (!fetched.ok) return { ok: false, diagnostics: fetched.diagnostics }
  const scopes = confirmFetchedScopes(cited.scopes, fetched.histories)
  if (!scopes.ok) return scopes
  const closure = await readCauseHistoryClosureFromPrimary(history, fetched.histories, (required) =>
    readComposedWorkflowHistory(required, options, [history]),
  )
  if (!closure.ok) return { ok: false, diagnostics: closure.diagnostics }
  const external = closure.histories.filter(
    (entry) =>
      entry.source.scope.repository !== history.source.scope.repository ||
      entry.source.scope.target !== history.source.scope.target,
  )
  const refs = confirmCitedRefs(cited.refs, external)
  if (!refs.ok) return refs
  return { ok: true, value: external }
}
