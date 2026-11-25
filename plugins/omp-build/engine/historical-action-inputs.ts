import { canonicalValueDigest, selectorAdmitted, validateActionInputs } from './action-input.ts'
import type { ActionInputs, RecordInputRef } from './action-input-schema.ts'
import { hasObservedGitPin } from './historical-git-pins.ts'
import { hasObservedRecordPin } from './historical-record-pins.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import type { ActionReceiptPayload } from './workflow-receipt-schema.ts'

export function selectedRecordValue(value: unknown, selector: string): unknown {
  if (!selector.startsWith('/')) return undefined
  let current = value
  for (const token of selector.slice(1).split('/')) {
    if (current === null || typeof current !== 'object') return undefined
    if (/~(?![01])/.test(token)) return undefined
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current) && !/^(0|[1-9]\d*)$/.test(key)) return undefined
    if (!Object.hasOwn(current, key)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

export function recordRefDiagnostics(
  label: string,
  ref: RecordInputRef,
  histories: readonly DecodedHistory[],
): Diagnostic[] {
  const history = historyFor(ref.record.scope, histories)
  if (history === null) return [diagnostic('missing-history', `${label} has no history for ${ref.record.recordId}`)]
  const bound = bindExternalRef(ref.record, history)
  if (!bound.ok) return [...bound.diagnostics]
  if (!equalScope({ repository: bound.value.repository, target: bound.value.target }, ref.record.scope))
    return [diagnostic('unbound', `${label} record ${ref.record.recordId} belongs to another scope`)]
  const selected = selectedRecordValue(bound.value, ref.selector)
  return selected !== undefined && canonicalValueDigest(selected) === ref.digest
    ? []
    : [diagnostic('mismatch', `${label} observation digest does not match ${ref.record.recordId}`)]
}

const payloadOnlyKinds: Record<string, true> = {
  'operator-control': true,
  'spec-identity': true,
  'cause-disposition': true,
  'cause-operation': true,
  mandate: true,
  'workflow-binding': true,
  decision: true,
  review: true,
  'fix-request': true,
  'correction-result': true,
  'falsification-result': true,
}

function expandedSelectorAllowed({ record: { kind }, selector }: RecordInputRef): boolean {
  if (selector.includes('/native') || selector.includes('/rawAttempts')) return false
  if (Object.hasOwn(payloadOnlyKinds, kind)) return selector === '/payload'
  if (kind === 'contribution') return selector === '/payload' || /^\/payload\/findings(?:\/\d+)?$/.test(selector)
  if (kind === 'review-attempt') return /^\/payload(?:\/inputSnapshot(?:\/.*)?)?$/.test(selector)
  if (kind !== 'action-receipt' && kind !== 'fix-result') return false
  return (
    selector === '/payload' ||
    (kind === 'action-receipt' && (selectorAdmitted('plan', selector) || selectorAdmitted('plan-review', selector))) ||
    selectorAdmitted('implementation', selector) ||
    selectorAdmitted('integration', selector) ||
    selectorAdmitted('criterion-evidence', selector)
  )
}

function expandedRecordDiagnostics(ref: RecordInputRef, histories: readonly DecodedHistory[]): Diagnostic[] {
  if (!expandedSelectorAllowed(ref))
    return [diagnostic('unconfirmed', 'Historical action manifest cites an unsupported record selector')]
  if (historyFor(ref.record.scope, histories) === null && hasObservedRecordPin(histories, ref)) return []
  return recordRefDiagnostics('Historical action manifest', ref, histories)
}

/** Historical authority requires every manifest Git file and expanded record to be re-observed. */
export function authenticateHistoricalActionInputs(
  inputs: ActionInputs,
  histories: readonly DecodedHistory[],
): Result<ActionInputs> {
  const valid = validateActionInputs(inputs)
  if (!valid.ok) return valid
  const { repositoryReferences, plugin, expandedContext } = valid.value.manifest
  for (const ref of repositoryReferences) if (!hasObservedGitPin(histories, ref)) return unobservedGitPin(ref.path)
  for (const ref of plugin.files) if (!hasObservedGitPin(histories, ref)) return unobservedGitPin(ref.path)
  for (const ref of expandedContext) {
    if (ref.source === 'record') {
      const diagnostics = expandedRecordDiagnostics(ref, histories)
      if (diagnostics.length !== 0) return { ok: false, diagnostics }
    } else if (!hasObservedGitPin(histories, ref)) return unobservedGitPin(ref.path)
  }
  return valid
}

function unobservedGitPin(path: string): Result<never> {
  return {
    ok: false,
    diagnostics: [diagnostic('unconfirmed', `Historical action manifest has no authenticated bytes for ${path}`)],
  }
}

export function authenticatedReceiptActionInputs(
  payload: ActionReceiptPayload,
  histories: readonly DecodedHistory[],
): boolean {
  return (
    authenticateHistoricalActionInputs(payload.inputs, histories).ok &&
    (payload.action !== 'plan-review' ||
      payload.slots.every(
        (slot) => !slot.action || authenticateHistoricalActionInputs(slot.action.inputs, histories).ok,
      ))
  )
}
