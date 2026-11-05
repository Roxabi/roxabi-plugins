import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { resolveCauseActionInputs } from './cause-adjudication.ts'
import type { CauseContext } from './finding-target.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { originalContributionAction } from './review-original-action.ts'
import { sameOwnSpecRef } from './spec-effective.ts'
import { bindExternalRef } from './workflow-control.ts'

type Pending = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
const unavailable = () => ({
  ok: false as const,
  diagnostics: [diagnostic('cause-source-unconfirmed', 'Retained source provenance is not authenticated')],
})

function contributionInputs(
  source: Contribution,
  histories: readonly DecodedHistory[],
  context: CauseContext,
): Result<readonly ActionInputs[]> {
  const scope = { repository: source.repository, target: source.target }
  const history = histories.find((item) => equalScope(item.source.scope, scope))
  if (!history) return unavailable()
  const action = originalContributionAction(source, history)
  if (!action.ok) return action
  const inputs = action.value
  if (
    inputs.manifest.spec.kind !== 'accepted' ||
    !sameOwnSpecRef(inputs.manifest.spec.effective.own, context.effective.own) ||
    canonicalValueDigest(inputs.manifest.spec.effective) !== canonicalValueDigest(context.effective)
  )
    return unavailable()
  return { ok: true, value: [inputs] }
}

export function resolveAdjudicationSources(input: {
  pending: Pending
  histories: readonly DecodedHistory[]
  context: CauseContext
}): Result<readonly ActionInputs[]> {
  if (
    !equalScope(input.pending.payload.origin.uw, input.context.original) ||
    !sameOwnSpecRef(input.pending.payload.origin, input.context.effective.own)
  )
    return unavailable()
  const subject = input.pending.payload.subject
  const ref: ExternalRecordRef =
    subject.kind === 'cause'
      ? subject.decision
      : subject.kind === 'retained-finding'
        ? subject.contribution
        : subject.source
  const history = input.histories.find((item) => equalScope(item.source.scope, ref.scope))
  if (!history) return unavailable()
  const source = bindExternalRef(ref, history)
  if (!source.ok) return source
  if (source.value.kind === 'decision')
    return resolveCauseActionInputs({ decision: source.value, history, context: input.context })
  if (source.value.kind !== 'contribution' || subject.kind === 'cause') return unavailable()
  if (subject.kind === 'retained-finding') {
    const finding = source.value.payload.findings?.find((item) => item.id === subject.finding.id)
    if (!finding || canonicalValueDigest(finding) !== canonicalValueDigest(subject.finding)) return unavailable()
  }
  return contributionInputs(source.value, input.histories, input.context)
}
