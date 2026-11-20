import type { Result } from '../engine/result.ts'
import type { ActionInputs, UwActionPorts } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'

export async function readReplaySources(rebuilt: ActionInputs, ports: UwActionPorts): Promise<Result<true>> {
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
