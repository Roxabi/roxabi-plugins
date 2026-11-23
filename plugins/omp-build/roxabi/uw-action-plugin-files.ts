import { canonicalValueDigest } from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import type { ActionInputManifest, InstalledPluginPin, PinnedFileRef, UwActionPorts } from './uw-action-contract.ts'
import { actionFailure, sha256Bytes } from './uw-action-result.ts'

export const REQUIRED_PLUGIN = [
  'package.json',
  'GLOSSARY.md',
  'skills/dev-review/review-classes.yml',
  'skills/dev-review/chunker.py',
  'skills/dev-review/digest.py',
  'skills/dev-review/prepare_context.py',
  'skills/dev-review/evidence-policy.md',
  'skills/dev-review/root-causes.md',
  'skills/dev-review/review-smells.md',
  'skills/dev-review/review-blind-spots.md',
] as const

// The snapshot format and ordered native review catalogue shipped together in 0.15.0–0.21.14.
// Keep paths only; the retired profile bytes are read at the review's pinned tooling commit.
const NATIVE_REVIEW_PLUGIN = [
  ...REQUIRED_PLUGIN,
  'agents/R-review-adversarial.md',
  'agents/R-review-security-auditor.md',
  'agents/R-review-architect.md',
  'agents/R-review-devops.md',
  'agents/R-review-tester.md',
  'agents/R-review-spec.md',
  'agents/R-review-synthesis.md',
  'agents/R-review-fix-intake.md',
  'agents/R-review-fix-synthesis.md',
  'agents/R-review-fix-apply.md',
  'agents/R-review-fix-falsify.md',
  'agents/R-review-recall.md',
] as const

type ReviewPluginPin = ActionInputManifest['plugin']

export async function verifyReviewPluginInventory(
  reviewed: ReviewPluginPin,
  installed: ReviewPluginPin,
  ports: UwActionPorts,
): Promise<Result<true>> {
  if (reviewed.repository !== installed.repository || reviewed.root !== installed.root)
    return actionFailure(
      'review-input-changed',
      'Reviewed tooling is not from the installed plugin repository and root',
    )
  if (reviewed.commit === installed.commit)
    return canonicalValueDigest(reviewed) === canonicalValueDigest(installed)
      ? { ok: true, value: true }
      : actionFailure('review-input-changed', 'Reviewed tooling pin does not exactly match the installed inventory')

  const version = /^0\.(1[5-9]|2[01])\.(0|[1-9]\d*)$/.exec(reviewed.version)
  if (version === null || (version[1] === '21' && Number(version[2]) > 14))
    return actionFailure('review-input-changed', `Unsupported historical review tooling version: ${reviewed.version}`)
  if (
    reviewed.files.length !== NATIVE_REVIEW_PLUGIN.length ||
    NATIVE_REVIEW_PLUGIN.some((path, index) => {
      const ref = reviewed.files[index]
      return (
        ref?.path !== `${reviewed.root}/${path}` ||
        ref.repository !== reviewed.repository ||
        ref.commit !== reviewed.commit
      )
    })
  )
    return actionFailure(
      'review-input-changed',
      'Reviewed tooling does not contain the exact ordered native review inventory',
    )
  const remote = await readPinnedPluginFiles(reviewed.files, ports)
  if (!remote.ok) return remote
  try {
    const identity: { name?: unknown; version?: unknown } = JSON.parse(Buffer.from(remote.value[0]).toString('utf8'))
    if (identity?.name === reviewed.name && identity?.version === reviewed.version) return { ok: true, value: true }
  } catch {
    // A non-package blob is not a historical tooling identity.
  }
  return actionFailure('review-input-changed', 'Reviewed tooling identity does not match its pinned package.json')
}

/** One invocation only: ordered, complete and independently digest-checked. */
export async function readPinnedPluginFiles(
  refs: readonly PinnedFileRef[],
  ports: UwActionPorts,
): Promise<Result<readonly Uint8Array[]>> {
  let bytes: readonly Uint8Array[]
  if (ports.readPinnedFiles !== undefined) {
    const result = await ports.readPinnedFiles(refs)
    if (!result.ok) return result
    bytes = result.value
  } else {
    const values: Uint8Array[] = []
    for (const ref of refs) {
      const result = await ports.readPinnedFile(ref)
      if (!result.ok) return result
      values.push(result.value)
    }
    bytes = values
  }
  if (bytes.length !== refs.length) return actionFailure('record-unreadable', 'Pinned plugin catalogue is incomplete')
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i]
    const value = bytes[i]
    if (ref === undefined || value === undefined || sha256Bytes(value) !== ref.digest)
      return actionFailure('plugin-pin-mismatch', 'Plugin pin no longer matches the committed bytes')
  }
  return { ok: true, value: bytes }
}

export async function verifiedPluginFiles(
  ports: UwActionPorts,
  pin: InstalledPluginPin,
): Promise<Result<{ refs: PinnedFileRef[]; files: { path: string; bytes: Uint8Array }[] }>> {
  const refs: PinnedFileRef[] = []
  const files: { path: string; bytes: Uint8Array }[] = []
  for (const path of REQUIRED_PLUGIN) {
    const installed = await ports.plugin.readInstalledFile(path)
    if (!installed.ok) return installed
    refs.push({
      source: 'git-file',
      repository: pin.repository,
      commit: pin.commit,
      path: `${pin.root}/${path}`,
      digest: sha256Bytes(installed.value),
    })
    files.push({ path: `plugin/${path}`, bytes: installed.value })
  }
  const remote = await readPinnedPluginFiles(refs, ports)
  if (!remote.ok) return remote
  for (let i = 0; i < files.length; i++) {
    const installed = files[i]
    const pinned = remote.value[i]
    if (
      installed === undefined ||
      pinned === undefined ||
      Buffer.compare(Buffer.from(installed.bytes), Buffer.from(pinned)) !== 0
    )
      return actionFailure(
        'plugin-pin-mismatch',
        `Installed ${installed?.path ?? 'plugin'} does not equal ${pin.repository}@${pin.commit}`,
      )
  }
  return { ok: true, value: { refs, files } }
}
