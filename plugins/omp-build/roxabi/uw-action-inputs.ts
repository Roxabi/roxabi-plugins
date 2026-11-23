import {
  ACTION_BINDING_FORMAT,
  ACTION_INPUT_FORMAT,
  actionInputDigest,
  canonicalValueDigest,
  citesCurrentRootOutput,
  validateActionInputs,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type {
  ActionInputManifest,
  ActionInputs,
  CorrectionRootRef,
  PreparedUwAction,
  ReviewRootRef,
  SelectedReview,
  UwActionPorts,
  UwActionRequest,
} from './uw-action-contract.ts'
import { dossierIndex, materializeActionFiles, repositorySealPath } from './uw-action-dossier.ts'
import { acceptCurrentManifest, verifyExpandedContext, verifyReviewedPlugin } from './uw-action-expanded.ts'
import { verifiedPluginFiles, verifyReviewPluginInventory } from './uw-action-plugin-files.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'
import { sealActionSnapshot } from './uw-action-snapshot.ts'
import { correctionLocalPorts } from './uw-correction-local-ports.ts'
import { selectedReviewInputs, selectedReviewRoot } from './uw-selected-review.ts'

async function resolveFiles(
  request: UwActionRequest,
  ports: UwActionPorts,
  manifest: ActionInputManifest,
  verifiedPluginFiles: readonly { path: string; bytes: Uint8Array }[],
): Promise<Result<readonly { path: string; bytes: Uint8Array }[]>> {
  const materialized = await materializeActionFiles(ports, manifest, request.stageSources)
  if (!materialized.ok) return materialized
  const files = [...materialized.value]
  files.push(...verifiedPluginFiles)
  const used = new Set<string>()
  for (const ref of manifest.repositoryReferences) {
    const bytes = await ports.readPinnedFile(ref)
    if (!bytes.ok) return bytes
    if (sha256Bytes(bytes.value) !== ref.digest)
      return actionFailure('action-input-stale', `Repository reference digest changed: ${ref.path}`)
    files.push({ path: repositorySealPath(ref, used), bytes: bytes.value })
  }
  files.push({ path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest), 'utf8') })
  files.push({ path: 'index.md', bytes: dossierIndex(manifest, files) })
  return { ok: true, value: files }
}

async function buildManifest(
  request: UwActionRequest,
  ports: UwActionPorts,
  reviewedFingerprint?: string,
  reviewedRoot?: ReviewRootRef,
  correctionRoot?: CorrectionRootRef,
  reviewedPlugin?: ActionInputManifest['plugin'],
): Promise<Result<{ manifest: ActionInputManifest; pluginFiles: readonly { path: string; bytes: Uint8Array }[] }>> {
  const pin = await ports.plugin.resolveInstalledPluginPin()
  if (!pin.ok) return pin
  const facts = await ports.readCurrentActionFacts(request, reviewedFingerprint, reviewedRoot, correctionRoot)
  if (!facts.ok) return facts
  const references = await ports.repositoryReferences(request, facts.value.plannedPaths)
  if (!references.ok) return references
  const plugin = await verifiedPluginFiles(ports, pin.value)
  if (!plugin.ok) return plugin
  const installed = { ...pin.value, files: plugin.value.refs }
  if (reviewedPlugin !== undefined) {
    const verified = await verifyReviewPluginInventory(reviewedPlugin, installed, ports)
    if (!verified.ok) return verified
  }
  const draft: ActionInputManifest = {
    format: ACTION_INPUT_FORMAT,
    purpose: request.purpose,
    subject: facts.value.subject,
    spec: facts.value.spec,
    code: request.code,
    acceptedSources: facts.value.acceptedSources,
    deliveryData: facts.value.deliveryData,
    repositoryReferences: references.value,
    plugin: reviewedPlugin ?? installed,
    configuration: facts.value.configuration,
    ...(facts.value.operands === undefined ? {} : { operands: facts.value.operands }),
    expandedContext: [...request.expandedContext],
  }
  if (facts.value.expansionPrevious !== undefined) {
    const old = facts.value.expansionPrevious.manifest
    if (actionInputDigest({ ...draft, expandedContext: old.expandedContext }) !== actionInputDigest(old))
      return actionFailure('review-input-changed', 'Expanded action changes the original manifest authority or sources')
  }
  const inputs: ActionInputs = {
    format: ACTION_BINDING_FORMAT,
    manifest: draft,
    fingerprint: actionInputDigest(draft),
    stageSources: [...request.stageSources],
  }
  const validated = validateActionInputs(inputs)
  if (!validated.ok) return { ok: false, diagnostics: validated.diagnostics }
  const accepted = await acceptCurrentManifest(request, ports, validated.value.manifest, facts.value.currentOutputs)
  return accepted.ok ? { ok: true, value: { manifest: accepted.value, pluginFiles: plugin.value.files } } : accepted
}

export async function prepareUwAction(
  request: UwActionRequest,
  ports: UwActionPorts,
  review?: SelectedReview,
  correctionRoot?: CorrectionRootRef,
): Promise<Result<PreparedUwAction>> {
  const scoped = correctionLocalPorts(request, ports)
  const built = await buildManifest(request, scoped, review?.fingerprint, review?.root, correctionRoot)
  if (!built.ok) return built
  const { manifest, pluginFiles } = built.value
  const files = await resolveFiles(request, scoped, manifest, pluginFiles)
  if (!files.ok) return files
  const placed = await ports.snapshots.create({ actionId: request.actionId, files: files.value })
  if (!placed.ok) return placed
  const sealed = sealActionSnapshot(
    {
      id: placed.value.indexPath,
      actionId: request.actionId,
      manifestDigest: actionInputDigest(manifest),
      indexPath: placed.value.indexPath,
      location: placed.value.location,
    },
    files.value,
  )
  if (!sealed.ok) return sealed
  const inputs: ActionInputs = {
    format: ACTION_BINDING_FORMAT,
    manifest,
    fingerprint: sealed.value.manifestDigest,
    stageSources: [...request.stageSources],
  }
  return { ok: true, value: { inputs, snapshot: sealed.value } }
}

async function readReplaySources(rebuilt: ActionInputs, ports: UwActionPorts): Promise<Result<true>> {
  for (const ref of rebuilt.manifest.repositoryReferences) {
    const read = await ports.readPinnedFile(ref)
    if (!read.ok) return read
  }
  const records = [...rebuilt.manifest.acceptedSources, ...rebuilt.manifest.deliveryData]
  const selected = await ports.readRecords(records)
  if (!selected.ok) return selected
  if (selected.value.length !== records.length)
    return actionFailure('record-unreadable', 'Selected record batch returned an unexpected number of values')
  return { ok: true, value: true }
}

export async function replayUwActionInputs(
  input: {
    reviewed: ActionInputs
    request: UwActionRequest
    reviewedRoot?: ReviewRootRef
    correctionRoot?: CorrectionRootRef
  },
  ports: UwActionPorts,
): Promise<Result<ActionInputs>> {
  const scoped = correctionLocalPorts(input.request, ports)
  if (
    input.request.expandedContext.length > 0 &&
    canonicalValueDigest(input.request.expandedContext) !==
      canonicalValueDigest(input.reviewed.manifest.expandedContext)
  )
    return actionFailure('review-input-changed', 'Reviewed replay cannot expand or replace reviewed context')
  const expanded = await verifyExpandedContext(input.reviewed.manifest.expandedContext, scoped)
  if (!expanded.ok) return expanded
  const plugin = await verifyReviewedPlugin(input.reviewed.manifest, scoped)
  if (!plugin.ok) return plugin
  const facts = await scoped.readCurrentActionFacts(
    input.request,
    input.reviewed.fingerprint,
    input.reviewedRoot,
    input.correctionRoot,
  )
  if (!facts.ok) return facts
  const rebuilt: ActionInputs = {
    format: ACTION_BINDING_FORMAT,
    manifest: {
      ...input.reviewed.manifest,
      code: input.request.code,
      subject: facts.value.subject,
      spec: facts.value.spec,
      acceptedSources: facts.value.acceptedSources,
      deliveryData: facts.value.deliveryData,
      ...(facts.value.operands === undefined ? { operands: undefined } : { operands: facts.value.operands }),
      configuration: facts.value.configuration,
    },
    fingerprint: '',
    stageSources: [...input.request.stageSources],
  }
  const sources = await readReplaySources(rebuilt, scoped)
  if (!sources.ok) return sources
  rebuilt.fingerprint = actionInputDigest(rebuilt.manifest)
  const validated = validateActionInputs(rebuilt)
  if (!validated.ok) return { ok: false, diagnostics: validated.diagnostics }
  const cited = citesCurrentRootOutput(validated.value, facts.value.currentOutputs)
  if (cited.length > 0) return { ok: false, diagnostics: cited }
  if (validated.value.fingerprint !== input.reviewed.fingerprint)
    return actionFailure('review-input-changed', 'Reconstructed action inputs do not match the reviewed fingerprint')
  if (
    input.request.purpose === 'integrate' &&
    canonicalValueDigest(validated.value) !== canonicalValueDigest(input.reviewed)
  )
    return actionFailure('review-input-changed', 'Reconstructed integration binding does not match the reviewed inputs')
  return validated
}
type StoredReview = { history: DecodedHistory; reviewId: string; fingerprint: string }

function selectStoredReview({ history, reviewId, fingerprint }: StoredReview) {
  const root = selectedReviewRoot(history, reviewId)
  if (!root.ok) return root
  const inputs = selectedReviewInputs(history, root.value, fingerprint)
  return inputs.ok ? { ok: true as const, value: { root: root.value, inputs: inputs.value } } : inputs
}
export async function replayStoredReviewAttempt(
  input: StoredReview & { head: string; repository: string; pr: number; base: string },
  ports: UwActionPorts,
): Promise<Result<ActionInputs>> {
  const selected = selectStoredReview(input)
  if (!selected.ok) return selected
  const { root, inputs } = selected.value
  if (inputs.manifest.subject.kind !== 'uw')
    return actionFailure('review-input-changed', 'reviewed action inputs are absent')
  return replayUwActionInputs(
    {
      reviewed: inputs,
      reviewedRoot: root,
      request: {
        actionId: `review-${input.pr}`,
        purpose: 'review',
        subject: inputs.manifest.subject,
        code: { repository: input.repository, base: input.base, head: input.head, referenceCommit: input.head },
        stageSources: [],
        expandedContext: [],
      },
    },
    ports,
  )
}
export async function currentActionFingerprint(
  request: UwActionRequest,
  ports: UwActionPorts,
  review?: StoredReview,
): Promise<Result<string>> {
  if (review === undefined) {
    const built = await buildManifest(request, ports)
    return built.ok ? { ok: true, value: actionInputDigest(built.value.manifest) } : built
  }
  const selected = selectStoredReview(review)
  if (!selected.ok) return selected
  const { inputs, root } = selected.value
  // The current install must still match its trusted pin. Only after verifying the selected
  // review's complete inventory can that attempt's different tooling pin be used.
  // Only the tooling pin and explicitly reviewed context are historical. Rediscover repository refs
  // and rebuild all candidate facts from the current request before comparing the fingerprint.
  const built = await buildManifest(
    { ...request, stageSources: inputs.stageSources, expandedContext: inputs.manifest.expandedContext },
    ports,
    review.fingerprint,
    root,
    undefined,
    inputs.manifest.plugin,
  )
  return built.ok ? { ok: true, value: actionInputDigest(built.value.manifest) } : built
}
