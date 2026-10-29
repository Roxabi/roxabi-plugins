import {
  ACTION_BINDING_FORMAT,
  ACTION_INPUT_FORMAT,
  actionInputDigest,
  actionInputsSchema,
  canonicalValueDigest,
  citesCurrentRootOutput,
  recordsOf,
  validateActionInputs,
} from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import { registerHostActionBinding } from '../omp/review-runtime/action-registry.ts'
import type {
  ActionInputManifest,
  ActionInputs,
  ActionSnapshot,
  PreparedUwAction,
  ResolvedActionInputs,
  ReviewActionProjection,
  UwActionPorts,
  UwActionRequest,
} from './uw-action-contract.ts'
import { materializeActionFiles } from './uw-action-dossier.ts'
import { acceptCurrentManifest, verifyExpandedContext, verifyReviewedPlugin } from './uw-action-expanded.ts'
import { verifiedPluginFiles } from './uw-action-plugin-files.ts'
import { projectionFiles, repositorySealPath, sealedIndex } from './uw-action-projection.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'
import { sealActionSnapshot, verifyActionSnapshot } from './uw-action-snapshot.ts'
import { correctionLocalPorts } from './uw-correction-local-ports.ts'

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8')
}

async function resolveFiles(
  request: UwActionRequest,
  ports: UwActionPorts,
  manifest: ActionInputManifest,
  verifiedPluginFiles: readonly { path: string; bytes: Uint8Array }[],
  projection?: ReviewActionProjection,
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
  if (projection !== undefined) {
    const projected = await projectionFiles(ports, manifest, projection)
    if (!projected.ok) return projected
    files.push(...projected.value)
  }
  files.push({ path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest), 'utf8') })
  files.push({ path: 'index.md', bytes: sealedIndex(manifest, files, projection) })
  return { ok: true, value: files }
}

async function buildManifest(
  request: UwActionRequest,
  ports: UwActionPorts,
): Promise<
  Result<{ manifest: ActionInputManifest; verifiedPluginFiles: readonly { path: string; bytes: Uint8Array }[] }>
> {
  const pin = await ports.plugin.resolveInstalledPluginPin()
  if (!pin.ok) return pin
  const facts = await ports.readCurrentActionFacts(request)
  if (!facts.ok) return facts
  const references = await ports.repositoryReferences(request)
  if (!references.ok) return references
  const plugin = await verifiedPluginFiles(request, ports, pin.value)
  if (!plugin.ok) return plugin
  const draft: ActionInputManifest = {
    format: ACTION_INPUT_FORMAT,
    purpose: request.purpose,
    subject: facts.value.subject,
    spec: facts.value.spec,
    code: request.code,
    acceptedSources: facts.value.acceptedSources,
    deliveryData: facts.value.deliveryData,
    repositoryReferences: references.value,
    plugin: { ...pin.value, files: plugin.value.refs },
    configuration: facts.value.configuration,
    expandedContext: [...request.expandedContext],
  }
  if (facts.value.expansionPrevious !== undefined) {
    const old = facts.value.expansionPrevious.manifest
    if (canonicalValueDigest({ ...draft, expandedContext: old.expandedContext }) !== canonicalValueDigest(old))
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
  return accepted.ok
    ? { ok: true, value: { manifest: accepted.value, verifiedPluginFiles: plugin.value.files } }
    : accepted
}

export async function prepareUwAction(
  request: UwActionRequest,
  ports: UwActionPorts,
  projection?: ReviewActionProjection,
): Promise<Result<PreparedUwAction>> {
  const scoped = correctionLocalPorts(request, ports)
  const manifest = await buildManifest(request, scoped)
  if (!manifest.ok) return manifest
  const files = await resolveFiles(
    request,
    scoped,
    manifest.value.manifest,
    manifest.value.verifiedPluginFiles,
    projection,
  )
  if (!files.ok) return files
  const placed = await ports.snapshots.create({ actionId: request.actionId, files: files.value })
  if (!placed.ok) return placed
  const sealed = sealActionSnapshot(
    {
      id: placed.value.indexPath,
      actionId: request.actionId,
      manifestDigest: actionInputDigest(manifest.value.manifest),
      indexPath: placed.value.indexPath,
      location: placed.value.location,
    },
    files.value,
  )
  if (!sealed.ok) return sealed
  const inputs: ActionInputs = {
    format: ACTION_BINDING_FORMAT,
    manifest: manifest.value.manifest,
    fingerprint: sealed.value.manifestDigest,
    stageSources: [...request.stageSources],
  }
  registerHostActionBinding(sealed.value, inputs)
  return { ok: true, value: { inputs, snapshot: sealed.value } }
}

export async function replayUwActionInputs(
  input: { reviewed: ActionInputs; request: UwActionRequest },
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
  const facts = await scoped.readCurrentActionFacts(input.request, input.reviewed.fingerprint)
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
      configuration: facts.value.configuration,
    },
    fingerprint: '',
    stageSources: [...input.request.stageSources],
  }
  for (const ref of [
    ...rebuilt.manifest.repositoryReferences,
    ...rebuilt.manifest.acceptedSources,
    ...rebuilt.manifest.deliveryData,
  ]) {
    const read = ref.source === 'record' ? await scoped.readRecord(ref) : await scoped.readPinnedFile(ref)
    if (!read.ok) return read
  }
  rebuilt.fingerprint = actionInputDigest(rebuilt.manifest)
  const validated = validateActionInputs(rebuilt)
  if (!validated.ok) return { ok: false, diagnostics: validated.diagnostics }
  const cited = citesCurrentRootOutput(validated.value, facts.value.currentOutputs)
  if (cited.length > 0) return { ok: false, diagnostics: cited }
  if (validated.value.fingerprint !== input.reviewed.fingerprint)
    return actionFailure('review-input-changed', 'Reconstructed action inputs do not match the reviewed fingerprint')
  return validated
}
export function storedReviewExpansion(
  history: DecodedHistory,
  fingerprint: string,
): Result<{
  expandedContext: ActionInputs['manifest']['expandedContext']
  stageSources: ActionInputs['stageSources']
}> {
  const stored = recordsOf(history).find(
    (record) =>
      record.kind === 'review-attempt' &&
      record.payload !== null &&
      typeof record.payload === 'object' &&
      (record.payload as { inputSnapshot?: { fingerprint?: unknown } }).inputSnapshot?.fingerprint === fingerprint,
  )
  const snapshot =
    stored?.payload !== null && typeof stored?.payload === 'object'
      ? (stored.payload as { inputSnapshot?: unknown }).inputSnapshot
      : null
  const parsed = actionInputsSchema.safeParse(snapshot)
  if (!parsed.success || parsed.data.fingerprint !== fingerprint)
    return actionFailure('review-input-changed', 'reviewed action inputs are absent')
  return {
    ok: true,
    value: { expandedContext: parsed.data.manifest.expandedContext, stageSources: parsed.data.stageSources },
  }
}
export async function replayStoredReviewAttempt(
  input: { history: DecodedHistory; head: string; fingerprint: string; repository: string; pr: number; base: string },
  ports: UwActionPorts,
): Promise<Result<ActionInputs>> {
  const stored = recordsOf(input.history).find((record) => {
    if (record.kind !== 'review-attempt' || record.payload === null || typeof record.payload !== 'object') return false
    const payload = record.payload as { input?: unknown; candidateGitSHA?: unknown }
    return payload.input === input.fingerprint && payload.candidateGitSHA === input.head
  })
  const payload = stored?.payload
  const parsed = actionInputsSchema.safeParse(
    payload !== null && typeof payload === 'object' ? (payload as { inputSnapshot?: unknown }).inputSnapshot : null,
  )
  if (!parsed.success || parsed.data.fingerprint !== input.fingerprint || parsed.data.manifest.subject.kind !== 'uw')
    return actionFailure('review-input-changed', 'reviewed action inputs are absent')
  return replayUwActionInputs(
    {
      reviewed: parsed.data,
      request: {
        actionId: `review-${input.pr}`,
        purpose: 'review',
        subject: parsed.data.manifest.subject,
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
): Promise<Result<string>> {
  const manifest = await buildManifest(request, ports)
  return manifest.ok ? { ok: true, value: actionInputDigest(manifest.value.manifest) } : manifest
}

export async function verifyPreparedSnapshot(snapshot: ActionSnapshot): Promise<Result<ActionSnapshot>> {
  return verifyActionSnapshot(snapshot)
}

export function snapshotPreview(files: readonly { path: string; bytes: Uint8Array }[]): string {
  return files.map((file) => `${file.path} ${file.bytes.byteLength}`).join('\n')
}

export function manifestText(bytes: Uint8Array): string {
  return text(bytes)
}

export type { ResolvedActionInputs }
