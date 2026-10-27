import {
  type CanonicalRecord,
  type DecodedHistory,
  historicalReviewAssociations,
  interruptiblePullRequestRoot,
  prepareReviewInterruptionPublication,
  prepareReviewReplacementGrantPublication,
  prepareReviewReplacementInventoryPublication,
  type Result,
  readReviewRecovery,
  selectWorkflowBinding,
} from '../dist/contracts.js'
import { boundSemanticFromHistoricalAssociation, reconstructHistoricalReviewInput } from './review-recovery-input.ts'

type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type WorkflowBinding = Extract<CanonicalRecord, { kind: 'workflow-binding' }>
type Mandate = Extract<CanonicalRecord, { kind: 'mandate' }>

function completeRecords(history: DecodedHistory): CanonicalRecord[] {
  return history.operations.flatMap((operation) =>
    operation.status === 'complete' && operation.record !== null ? [operation.record] : [],
  )
}

type RecoveryRecord = Extract<
  CanonicalRecord,
  { kind: 'review-interruption' | 'review-replacement-grant' | 'review-attempt' }
>

type RecoveryPublish = (record: RecoveryRecord) => Promise<Result<{ recordId: string }>>

async function publishAndConfirm<T extends RecoveryRecord>(ports: RecoveryHostPorts, record: T): Promise<Result<T>> {
  const published = await ports.publish(record)
  if (!published.ok) return { ok: false, diagnostics: published.diagnostics }
  const readback = await ports.readPullRequestHistory()
  const confirmed = completeRecords(readback).find((candidate) => candidate.recordId === record.recordId)
  if (confirmed === undefined || JSON.stringify(confirmed) !== JSON.stringify(record)) {
    return {
      ok: false,
      diagnostics: [{ code: 'unreadable', message: 'Published recovery record was not confirmed by exact readback' }],
    }
  }
  return { ok: true, value: record }
}

export function collectWorkflowBindings(history: DecodedHistory): WorkflowBinding[] {
  return completeRecords(history).filter((record): record is WorkflowBinding => record.kind === 'workflow-binding')
}

export function collectMandates(histories: readonly DecodedHistory[]): Mandate[] {
  const out: Mandate[] = []
  const seen = new Set<string>()
  for (const history of histories) {
    for (const record of completeRecords(history)) {
      if (record.kind !== 'mandate') continue
      const key = `${record.repository}\0${record.target}\0${record.recordId}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(record)
    }
  }
  return out
}

export type RecoveryHostPorts = {
  readPullRequestHistory: () => Promise<DecodedHistory>
  readExternalHistories: (bindings: readonly WorkflowBinding[]) => Promise<readonly DecodedHistory[]>
  publish: RecoveryPublish
  runId: string
}

/** Re-select the binding from complete histories; a merely present old binding is never fresh authority. */
async function selectCurrentBinding(input: {
  ports: RecoveryHostPorts
  history: DecodedHistory
  scope: { repository: string; target: string }
  native: { branch: string; base: string }
  binding: WorkflowBinding
}): Promise<Result<WorkflowBinding>> {
  const external = await input.ports.readExternalHistories(collectWorkflowBindings(input.history))
  const selected = selectWorkflowBinding({
    pullRequest: input.scope,
    histories: [input.history, ...external],
    native: input.native,
  })
  if (selected.status === 'bound' && JSON.stringify(selected.binding) === JSON.stringify(input.binding)) {
    return { ok: true, value: selected.binding }
  }
  return {
    ok: false,
    diagnostics:
      selected.status === 'bound'
        ? [{ code: 'unbound', message: 'Recovery binding is not the active verified binding' }]
        : selected.status === 'absent'
          ? [{ code: 'unbound', message: 'Pull request has no active workflow binding' }]
          : selected.diagnostics,
  }
}

/** Host terminalize: select B1/M1 only after I4 reconstruction, then confirm the terminal readback. */
export async function hostTerminalizeInterruptedReview(
  ports: RecoveryHostPorts,
): Promise<Result<{ recordId: string }>> {
  const history = await ports.readPullRequestHistory()
  const root = interruptiblePullRequestRoot(history)
  if (root === null) {
    return {
      ok: false,
      diagnostics: [{ code: 'unbound', message: 'No unique interrupted review root is terminalizable' }],
    }
  }
  const bindings = collectWorkflowBindings(history)
  const histories = [history, ...(await ports.readExternalHistories(bindings))]
  const associations = historicalReviewAssociations({
    root,
    bindings,
    mandates: collectMandates(histories),
    histories,
  })
  if (!associations.ok) return associations
  const matches = associations.value.flatMap((association) => {
    const semantic = boundSemanticFromHistoricalAssociation(association)
    if ('ok' in semantic) return []
    const reconstructed = reconstructHistoricalReviewInput({ root, semantic })
    if (reconstructed !== null && root.payload.input !== null && reconstructed === root.payload.input)
      return [{ association, reconstructed }]
    return []
  })
  if (matches.length !== 1) {
    return {
      ok: false,
      diagnostics: [
        { code: 'ambiguous', message: 'I4 reconstruction must select exactly one historical binding and mandate' },
      ],
    }
  }
  const prepared = prepareReviewInterruptionPublication({
    history,
    root,
    bindings: [matches[0].association.binding],
    mandates: [matches[0].association.mandate],
    histories,
    reconstructedInput: matches[0].reconstructed,
    runId: ports.runId,
  })
  if (!prepared.ok) return prepared
  const confirmed = await publishAndConfirm(ports, prepared.value)
  return confirmed.ok ? { ok: true, value: { recordId: confirmed.value.recordId } } : confirmed
}

/** Host grant: confirm one fresh exact binding/input/head allowance for its sole stopped root. */
export async function hostGrantInterruptedReviewReplacement(input: {
  ports: RecoveryHostPorts
  binding: WorkflowBinding
  candidateGitSHA: string
  digest: string
  branch: string
  base: string
}): Promise<Result<{ recordId: string }>> {
  const history = await input.ports.readPullRequestHistory()
  const recovery = readReviewRecovery(history)
  if (!recovery.ok) return recovery
  if (recovery.value.normalProgression !== 'stopped' || recovery.value.replacementGrant !== null) {
    return {
      ok: false,
      diagnostics: [{ code: 'unbound', message: 'Replacement grant requires one stopped root without a grant' }],
    }
  }
  const records = completeRecords(history)
  const roots = records.filter(
    (record): record is ReviewRoot =>
      record.kind === 'review-attempt' &&
      record.recordId === record.payload.rootAttemptId &&
      record.payload.stage === 'initial' &&
      record.payload.purpose === 'review' &&
      'subject' in record.payload &&
      record.payload.subject.kind === 'pull-request' &&
      records.some(
        (candidate) => candidate.kind === 'review-interruption' && candidate.payload.rootAttemptId === record.recordId,
      ),
  )
  if (roots.length !== 1) {
    return {
      ok: false,
      diagnostics: [
        { code: 'ambiguous', message: 'Replacement grant requires exactly one terminalized historical root' },
      ],
    }
  }
  const disposition = records.filter(
    (record) => record.kind === 'review-interruption' && record.payload.rootAttemptId === roots[0].recordId,
  )
  if (disposition.length !== 1) {
    return {
      ok: false,
      diagnostics: [{ code: 'ambiguous', message: 'Replacement grant requires exactly one interruption disposition' }],
    }
  }
  const binding = await selectCurrentBinding({
    ports: input.ports,
    history,
    scope: { repository: roots[0].repository, target: roots[0].target },
    native: { branch: input.branch, base: input.base },
    binding: input.binding,
  })
  if (!binding.ok) return binding
  const prepared = prepareReviewReplacementGrantPublication({
    history,
    root: roots[0],
    dispositionId: disposition[0].recordId,
    binding: binding.value,
    candidateGitSHA: input.candidateGitSHA,
    digest: input.digest,
    runId: input.ports.runId,
  })
  if (!prepared.ok) return prepared
  const confirmed = await publishAndConfirm(input.ports, prepared.value)
  return confirmed.ok ? { ok: true, value: { recordId: confirmed.value.recordId } } : confirmed
}

/** Host replace: publish the deterministic inventory and require a complete exact readback before activation. */
export async function hostReplaceInterruptedReview(input: {
  ports: RecoveryHostPorts
  template: ReviewRoot
  binding: WorkflowBinding
  branch: string
  base: string
}): Promise<Result<{ recordId: string; grantId: string; inventory: ReviewRoot }>> {
  const history = await input.ports.readPullRequestHistory()
  const recovery = readReviewRecovery(history)
  if (!recovery.ok) return recovery
  if (recovery.value.normalProgression !== 'stopped' || recovery.value.replacementGrant === null) {
    return {
      ok: false,
      diagnostics: [{ code: 'unbound', message: 'Replacement inventory requires one unconsumed replacement grant' }],
    }
  }
  const grantId = recovery.value.replacementGrant.recordId
  const binding = await selectCurrentBinding({
    ports: input.ports,
    history,
    scope: { repository: input.template.repository, target: input.template.target },
    native: { branch: input.branch, base: input.base },
    binding: input.binding,
  })
  if (!binding.ok) return binding
  const prepared = prepareReviewReplacementInventoryPublication({
    history,
    template: input.template,
    binding: binding.value,
    runId: input.ports.runId,
  })
  if (!prepared.ok) return prepared
  const published = await input.ports.publish(prepared.value)
  if (!published.ok) return published
  const readback = await input.ports.readPullRequestHistory()
  const confirmed = completeRecords(readback).find((record) => record.recordId === prepared.value.recordId)
  if (confirmed === undefined || JSON.stringify(confirmed) !== JSON.stringify(prepared.value)) {
    return {
      ok: false,
      diagnostics: [
        { code: 'unreadable', message: 'Replacement inventory publication was not confirmed by exact readback' },
      ],
    }
  }
  return { ok: true, value: { recordId: prepared.value.recordId, grantId, inventory: prepared.value } }
}

export { interruptiblePullRequestRoot }
