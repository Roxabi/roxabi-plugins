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

export async function materializeActionFiles(
  ports: Pick<UwActionPorts, 'readCodeDiff' | 'readRecords' | 'readPinnedFile'>,
  manifest: ActionInputManifest,
  stageSources: readonly RecordInputRef[],
): Promise<Result<readonly { path: string; bytes: Uint8Array }[]>> {
  const files: { path: string; bytes: Uint8Array }[] = []
  files.push({ path: 'spec.json', bytes: Buffer.from(JSON.stringify(manifest.spec), 'utf8') })
  if (manifest.operands !== undefined)
    files.push({
      path: 'action/exact-inputs.json',
      bytes: Buffer.from(JSON.stringify(manifest.operands.exactInputs), 'utf8'),
    })
  files.push({ path: 'fingerprint.txt', bytes: Buffer.from(`${actionInputDigest(manifest)}\n`, 'utf8') })
  const diff = await ports.readCodeDiff(manifest.code)
  if (!diff.ok) return diff
  files.push({ path: 'diff.patch', bytes: diff.value })
  const records = [
    ...manifest.acceptedSources.map((ref) => ({ ref, path: identityPath('records/accepted', ref) })),
    ...manifest.deliveryData.map((ref) => ({
      ref,
      path: identityPath(`records/${encodeURIComponent(ref.role)}`, ref),
    })),
    ...manifest.expandedContext.flatMap((ref, index) =>
      ref.source === 'record' ? [{ ref, path: `expanded/${index}.json` }] : [],
    ),
    ...stageSources.map((ref) => ({ ref, path: identityPath('stage', ref) })),
  ]
  const selected = await ports.readRecords(records.map(({ ref }) => ref))
  if (!selected.ok) return selected
  if (selected.value.length !== records.length)
    return actionFailure('record-unreadable', 'Selected record batch returned an unexpected number of values')
  for (const [index, record] of records.entries()) {
    const stored = place(files, record.path, Buffer.from(JSON.stringify(selected.value[index]), 'utf8'))
    if (!stored.ok) return stored
  }
  for (const [index, ref] of manifest.expandedContext.entries()) {
    if (ref.source === 'record') continue
    const bytes = await ports.readPinnedFile(ref)
    if (!bytes.ok) return bytes
    files.push({ path: `expanded/${index}.bin`, bytes: bytes.value })
  }
  files.push({ path: 'stage/annex.json', bytes: Buffer.from(JSON.stringify(stageSources), 'utf8') })
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
    ...(manifest.operands === undefined
      ? []
      : manifest.operands.action === 'assess-spec'
        ? ['## Exact inputs', 'Accepted state and proposed state: action/exact-inputs.json', '']
        : ['## Exact inputs', 'CI failures: action/exact-inputs.json', '']),
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
