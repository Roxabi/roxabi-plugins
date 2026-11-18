import type { DecodedHistory } from '../dist/contracts.js'
import { bindExternalRef, canonicalValueDigest } from '../dist/contracts.js'
import type { FixOwnerOpenedPayload } from '../engine/fix-recovery-schema.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure, recoveryDiagnosticStrings } from './fix-contract.ts'
import { configuration } from './uw-action-observe.ts'

/** Re-read the committed current configuration and its authenticated mandate, never copy an old verdict. */
export async function observeRecoveryConfiguration(input: {
  opening: FixOwnerOpenedPayload
  histories: readonly DecodedHistory[]
  cwd: string
  candidateGitSHA: string
}): Promise<FixActionResult<FixOwnerOpenedPayload['common']['configuration']>> {
  const ref = input.opening.common.mandate
  const homes = input.histories.filter(
    (history) =>
      history.source.scope.repository === ref.scope.repository &&
      history.source.scope.target === ref.scope.target &&
      history.source.complete,
  )
  const home = homes[0]
  if (homes.length !== 1 || home === undefined) return failure('fix-recovery-mandate-history-unavailable')
  const mandate = bindExternalRef({ scope: ref.scope, kind: 'mandate', recordId: ref.recordId }, home)
  if (!mandate.ok || mandate.value.kind !== 'mandate') return failure('fix-recovery-mandate-unconfirmed')
  const current = await configuration(input.cwd, input.candidateGitSHA)
  if (!current.ok) return failure(...recoveryDiagnosticStrings(current.diagnostics))
  const pinned = mandate.value.payload.config
  const expected = { version: pinned.version, digest: pinned.digest, serialized: JSON.stringify(pinned.effective) }
  if (canonicalValueDigest(expected) !== canonicalValueDigest(input.opening.common.configuration))
    return failure('fix-recovery-configuration-changed')
  return { ok: true, value: expected }
}
