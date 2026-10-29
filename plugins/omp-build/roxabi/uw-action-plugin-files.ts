import type { Result } from '../engine/result.ts'
import type { InstalledPluginPin, PinnedFileRef, UwActionPorts, UwActionRequest } from './uw-action-contract.ts'
import { suppliedProcedurePaths } from './uw-action-dossier.ts'
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
  request: UwActionRequest,
  ports: UwActionPorts,
  pin: InstalledPluginPin,
): Promise<Result<{ refs: PinnedFileRef[]; files: { path: string; bytes: Uint8Array }[] }>> {
  const refs: PinnedFileRef[] = []
  const files: { path: string; bytes: Uint8Array }[] = []
  for (const path of [...REQUIRED_PLUGIN, ...suppliedProcedurePaths(request.purpose)]) {
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
