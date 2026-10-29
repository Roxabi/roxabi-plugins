import { actionInputDigest } from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import { nativeFeatureProfiles } from './native-feature-profiles.ts'
import { nativeReviewProfiles } from './native-review-profiles.ts'
import type { ActionInputManifest, ActionInputs, RecordInputRef, UwActionPorts } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'

const REVIEW = new Set(['review', 'correction'])
const WORKFLOW = new Set(['plan', 'plan-review', 'implement', 'attribute-ci', 'assess-spec', 'normalize', 'frame'])

export function suppliedProcedurePaths(purpose: string): readonly string[] {
  const profiles = REVIEW.has(purpose) ? nativeReviewProfiles : WORKFLOW.has(purpose) ? nativeFeatureProfiles : []
  return profiles.map((profile) => `agents/${profile.name}.md`)
}

function forms(purpose: string): readonly { name: string; output: string }[] {
  const profiles = REVIEW.has(purpose) ? nativeReviewProfiles : WORKFLOW.has(purpose) ? nativeFeatureProfiles : []
  return profiles.map((profile) => ({ name: profile.name, output: profile.output }))
}

function specBody(spec: ActionInputManifest['spec']): {
  criteria: readonly { id: string; statement: string }[]
  invariants: readonly { id: string; statement: string }[]
  version: string | null
} {
  if (spec.kind === 'accepted')
    return {
      criteria: spec.effective.spec.criteria,
      invariants: spec.effective.spec.invariants,
      version: spec.effective.spec.version,
    }
  if (spec.kind === 'proposed')
    return {
      criteria: spec.snapshot.spec.criteria,
      invariants: spec.snapshot.spec.invariants,
      version: spec.snapshot.spec.version,
    }
  return { criteria: [], invariants: [], version: null }
}

function identityPath(namespace: string, ref: RecordInputRef): string {
  const scope = ref.record.scope
  return [
    namespace,
    encodeURIComponent(scope.repository),
    encodeURIComponent(scope.target),
    encodeURIComponent(ref.record.kind),
    encodeURIComponent(ref.record.recordId),
    encodeURIComponent(ref.selector) + '.json',
  ].join('/')
}

function place(files: { path: string; bytes: Uint8Array }[], path: string, bytes: Uint8Array): Result<true> {
  const existing = files.find((file) => file.path === path)
  if (existing === undefined) {
    files.push({ path, bytes })
    return { ok: true, value: true }
  }
  if (Buffer.compare(Buffer.from(existing.bytes), Buffer.from(bytes)) !== 0) {
    return actionFailure('record-unreadable', 'Selected identity is not unique: ' + path)
  }
  return { ok: true, value: true }
}

async function selected(
  ports: UwActionPorts,
  ref: RecordInputRef,
  path: string,
  files: { path: string; bytes: Uint8Array }[],
): Promise<Result<true>> {
  const value = await ports.readRecord(ref)
  if (!value.ok) return value
  return place(files, path, Buffer.from(JSON.stringify(value.value), 'utf8'))
}

async function storeRefs<T extends RecordInputRef>(
  ports: UwActionPorts,
  refs: readonly T[],
  pathFor: (ref: T) => string,
  files: { path: string; bytes: Uint8Array }[],
): Promise<Result<true>> {
  for (const ref of refs) {
    const stored = await selected(ports, ref, pathFor(ref), files)
    if (!stored.ok) return stored
  }
  return { ok: true, value: true }
}

async function storeExpanded(
  ports: UwActionPorts,
  refs: ActionInputManifest['expandedContext'],
  files: { path: string; bytes: Uint8Array }[],
): Promise<Result<true>> {
  for (const [index, ref] of refs.entries()) {
    const stored = await storeExpandedRef(ports, ref, index, files)
    if (!stored.ok) return stored
  }
  return { ok: true, value: true }
}

async function storeExpandedRef(
  ports: UwActionPorts,
  ref: ActionInputManifest['expandedContext'][number],
  index: number,
  files: { path: string; bytes: Uint8Array }[],
): Promise<Result<true>> {
  if (ref.source === 'record') return selected(ports, ref, `expanded/${index}.json`, files)
  const bytes = await ports.readPinnedFile(ref)
  if (!bytes.ok) return bytes
  files.push({ path: `expanded/${index}.bin`, bytes: bytes.value })
  return { ok: true, value: true }
}

export async function materializeActionFiles(
  ports: UwActionPorts,
  manifest: ActionInputManifest,
  stageSources: readonly RecordInputRef[],
): Promise<Result<readonly { path: string; bytes: Uint8Array }[]>> {
  const files: { path: string; bytes: Uint8Array }[] = []
  files.push({ path: 'spec.json', bytes: Buffer.from(JSON.stringify(manifest.spec), 'utf8') })
  files.push({ path: 'fingerprint.txt', bytes: Buffer.from(`${actionInputDigest(manifest)}\n`, 'utf8') })
  const diff = await ports.readCodeDiff(manifest.code)
  if (!diff.ok) return diff
  files.push({ path: 'diff.patch', bytes: diff.value })
  const accepted = await storeRefs(
    ports,
    manifest.acceptedSources,
    (ref) => identityPath('records/accepted', ref),
    files,
  )
  if (!accepted.ok) return accepted
  const delivery = await storeRefs(
    ports,
    manifest.deliveryData,
    (ref) => identityPath(`records/${encodeURIComponent(ref.role)}`, ref),
    files,
  )
  if (!delivery.ok) return delivery
  const expanded = await storeExpanded(ports, manifest.expandedContext, files)
  if (!expanded.ok) return expanded
  const stage: { path: string; bytes: Uint8Array }[] = []
  const staged = await storeRefs(ports, stageSources, (ref) => identityPath('stage', ref), stage)
  if (!staged.ok) return staged
  files.push(...stage, { path: 'stage/annex.json', bytes: Buffer.from(JSON.stringify(stageSources), 'utf8') })
  return { ok: true, value: files }
}

export function dossierIndex(manifest: ActionInputManifest, files: readonly { path: string }[]): Uint8Array {
  const fingerprint = actionInputDigest(manifest)
  const spec = specBody(manifest.spec)
  const named = files
    .map((file) => file.path)
    .filter((path) => path !== 'index.md')
    .concat('index.md')
  const lines = [
    '# ' + manifest.purpose,
    '',
    'Fingerprint: ' + fingerprint,
    'Stage annex: stage/annex.json',
    'Spec version: ' + (spec.version ?? 'absent'),
    '',
    '## Criteria',
    ...(spec.criteria.length === 0 ? ['- none'] : spec.criteria.map((item) => '- ' + item.id + ': ' + item.statement)),
    '',
    '## Invariants',
    ...(spec.invariants.length === 0
      ? ['- none']
      : spec.invariants.map((item) => '- ' + item.id + ': ' + item.statement)),
    '',
    '## Forms',
    ...forms(manifest.purpose).map((item) => '- ' + item.name + ': ' + item.output),
    '',
    '## Files',
    ...named.map((path) => '- ' + path),
    '',
  ]
  return Buffer.from(lines.join('\n'), 'utf8')
}

export function bindingFingerprint(inputs: ActionInputs): string {
  return actionInputDigest(inputs.manifest)
}
