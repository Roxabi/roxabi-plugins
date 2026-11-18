import { createHash } from 'node:crypto'
import type { Gh } from '../adapters/github/types.ts'
import { canonicalValueDigest } from '../dist/contracts.js'
import type { FixOwnerOpenedPayload } from '../engine/fix-recovery-schema.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure, recoveryDiagnosticStrings } from './fix-contract.ts'
import type { TrustedHostPluginPin } from './uw-action-contract.ts'
import { readGitFileBytes } from './uw-git-bytes.ts'
import { pluginPinPort } from './uw-plugin-pin.ts'

/** Independently re-read the approved installed pin and every exact file in the opening manifest. */
export async function observeRecoveryPlugin(input: {
  opening: FixOwnerOpenedPayload
  cwd: string
  gh: Gh
  trusted?: TrustedHostPluginPin
}): Promise<FixActionResult<FixOwnerOpenedPayload['common']['plugin']>> {
  const expected = input.opening.common.plugin
  const port = pluginPinPort({ cwd: input.cwd, gh: input.gh, trusted: input.trusted })
  const pin = await port.resolveInstalledPluginPin()
  if (!pin.ok) return failure(...recoveryDiagnosticStrings(pin.diagnostics))
  const { files, ...identity } = expected
  if (canonicalValueDigest(pin.value) !== canonicalValueDigest(identity)) return failure('fix-recovery-plugin-changed')
  const paths = new Set<string>()
  for (const ref of files) {
    const prefix = `${pin.value.root}/`
    if (
      ref.repository !== pin.value.repository ||
      ref.commit !== pin.value.commit ||
      !ref.path.startsWith(prefix) ||
      paths.has(ref.path)
    )
      return failure('fix-recovery-plugin-pin-invalid')
    paths.add(ref.path)
    const relative = ref.path.slice(prefix.length)
    const [installed, pinned] = await Promise.all([
      port.readInstalledFile(relative),
      readGitFileBytes({
        repository: ref.repository,
        commit: ref.commit,
        path: ref.path,
        cwd: input.cwd,
        gh: input.gh,
      }),
    ])
    if (
      !installed.ok ||
      !pinned.ok ||
      createHash('sha256').update(installed.value).digest('hex') !== ref.digest ||
      createHash('sha256').update(pinned.value).digest('hex') !== ref.digest ||
      Buffer.compare(Buffer.from(installed.value), Buffer.from(pinned.value)) !== 0
    )
      return failure('fix-recovery-plugin-file-changed')
  }
  return { ok: true, value: { ...pin.value, files: files.map((ref) => ({ ...ref })) } }
}
