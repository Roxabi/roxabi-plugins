import { canonicalValueDigest } from './action-input.ts'
import type { DispositionSource } from './cause-disposition.ts'
import type { CauseDispositionPayload } from './cause-disposition-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'

type Head = Extract<CanonicalRecord, { kind: 'cause-disposition' }>

function selectHead(outcome: CauseDispositionPayload, heads: readonly Head[]): Result<Head | undefined> {
  const key = canonicalValueDigest([outcome.origin, outcome.basis.versionVector, outcome.subject])
  const matching = heads.filter(
    (head) =>
      canonicalValueDigest([head.payload.origin, head.payload.basis.versionVector, head.payload.subject]) === key,
  )
  if (matching.length > 1)
    return { ok: false, diagnostics: [diagnostic('ambiguous', 'Disposition head is not unique')] }
  return { ok: true, value: matching[0] }
}

function assessSelected(
  selected: CauseDispositionPayload,
  head: Head | undefined,
  executableCauseIds: readonly string[],
  assessed: Set<string>,
  executable: string[],
): Result<true> {
  if (selected.outcome.state === 'pending-blocking')
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Correction disposition is pending approval')] }
  if (selected.subject.kind !== 'cause') {
    if (selected.outcome.blocking)
      return { ok: false, diagnostics: [diagnostic('unconfirmed', 'A retained disposition remains blocking')] }
    return { ok: true, value: true }
  }
  const id = selected.subject.cause.id
  if (assessed.has(id))
    return { ok: false, diagnostics: [diagnostic('ambiguous', 'Correction cause has multiple disposition outcomes')] }
  assessed.add(id)
  if (selected.outcome.disposition === 'fix-original') {
    if (head === undefined && !executableCauseIds.includes(id))
      return {
        ok: false,
        diagnostics: [diagnostic('unconfirmed', 'Correction plan cannot execute the selected cause')],
      }
    executable.push(id)
  } else if (selected.outcome.blocking) {
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Correction disposition blocks the selected cause')] }
  }
  return { ok: true, value: true }
}

/** Select the ordinary current disposition plan; approval and execution remain separate. */
export function selectFixRecoveryDispositionPlan(input: {
  outcomes: readonly CauseDispositionPayload[]
  heads: readonly Extract<CanonicalRecord, { kind: 'cause-disposition' }>[]
  executableCauseIds: readonly string[]
  source: DispositionSource
}): Result<{ executableCauseIds: string[] }> {
  const assessed = new Set<string>()
  const executable: string[] = []
  for (const outcome of input.outcomes) {
    const head = selectHead(outcome, input.heads)
    if (!head.ok) return head
    const selected = assessSelected(
      head.value?.payload ?? outcome,
      head.value,
      input.executableCauseIds,
      assessed,
      executable,
    )
    if (!selected.ok) return selected
  }
  if (
    input.source.kind === 'decision' &&
    input.source.decision.payload.judgment.causes.some((cause) => !assessed.has(cause.id))
  )
    return { ok: false, diagnostics: [diagnostic('unconfirmed', 'Correction plan does not assess every cause')] }
  return { ok: true, value: { executableCauseIds: executable } }
}
