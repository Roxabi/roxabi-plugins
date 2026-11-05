import { type CauseContext, resolveOwnSpecEffective, type Scope } from '../dist/contracts.js'
import { type FixActionResult, failure } from './fix-contract.ts'
import type { UwReadPort } from './uw-contract.ts'

/** Resolve the current accepted own Spec from the bound UW, never from request prose. */
export async function resolveFixOrigin(
  uw: Scope | undefined,
  reader: UwReadPort,
): Promise<FixActionResult<CauseContext>> {
  if (uw === undefined) return failure('correction-original-uw-required')
  try {
    const read = await reader.readUw(uw)
    if (read.accepted.status !== 'accepted') return failure('correction-spec-not-accepted')
    const effective = resolveOwnSpecEffective(read.accepted.value)
    if (!effective.ok) return failure('correction-spec-not-accepted', ...effective.diagnostics.map((item) => item.code))
    if (effective.value.own.uw.repository !== uw.repository || effective.value.own.uw.target !== uw.target)
      return failure('correction-origin-mismatch')
    return { ok: true, value: { original: uw, effective: effective.value } }
  } catch {
    return failure('correction-spec-not-accepted')
  }
}
