import type { CanonicalRecord, DecodedHistory } from '../dist/contracts.js'
import { canonicalValueDigest, deriveFixOwnerSettlementFacts, outboundOperationSchema } from '../dist/contracts.js'
import type { FixOwnerOpenedPayload, FixOwnerSettledPayload } from '../engine/fix-recovery-schema.ts'
import type { PreparationCohortResult } from '../host/preparation-cohort.ts'
import type { FixActionResult, PreparedFix } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import type { FixExecutionFence } from './fix-execution-fence.ts'
import type { FixPublicationObservation } from './fix-fence-operations.ts'
import { observeRecoveryGit } from './fix-recovery-git-observation.ts'
import { reconcileRecoveryHostEffects } from './fix-recovery-host-effects.ts'

type Opening = Extract<CanonicalRecord, { kind: 'fix-owner' }> & { payload: FixOwnerOpenedPayload }
type OwnerRecord = Extract<CanonicalRecord, { kind: 'fix-owner' }>
const pendingSettlements = new WeakMap<FixOwnerSettledPayload, { fence: FixExecutionFence; digest: string }>()
const originatingSettlements = new Map<string, { fence: FixExecutionFence; root: unknown; process: unknown }>()

/** The pending payload identity and live originating fence are required on every publication context read. */
export async function authorizePendingOriginatingSettlement(
  fence: FixExecutionFence,
  payload: FixOwnerSettledPayload,
  record: OwnerRecord,
): Promise<boolean> {
  const pending = pendingSettlements.get(payload)
  if (
    pending?.fence !== fence ||
    pending.digest !== canonicalValueDigest(payload) ||
    record.payload.phase !== 'settled' ||
    canonicalValueDigest(record.payload) !== pending.digest ||
    !fence.rootCurrent() ||
    !(await fence.recheckSettlementLease())
  )
    return false
  const host = await fence.joinSettlement()
  const lease = fence.destinationLeaseFacts()
  return (
    host.status === 'joined' &&
    fence.rootCurrent() &&
    fence.snapshot().root !== null &&
    lease !== null &&
    lease.host !== null
  )
}

/** Only the actual readback publisher may turn a prepared originating settlement into a live capability. */
export async function confirmOriginatingSettlement(
  fence: FixExecutionFence,
  payload: FixOwnerSettledPayload,
  record: OwnerRecord,
): Promise<boolean> {
  const pending = pendingSettlements.get(payload)
  if (
    pending?.fence !== fence ||
    pending.digest !== canonicalValueDigest(payload) ||
    record.payload.phase !== 'settled' ||
    canonicalValueDigest(record.payload) !== pending.digest ||
    !(await fence.recheckSettlementLease())
  )
    return false
  const host = await fence.joinSettlement()
  const snapshot = fence.snapshot()
  const lease = fence.destinationLeaseFacts()
  if (
    host.status !== 'joined' ||
    snapshot.root === null ||
    lease?.host === null ||
    lease === null ||
    !fence.rootCurrent()
  )
    return false
  pendingSettlements.delete(payload)
  originatingSettlements.set(canonicalValueDigest(record), { fence, root: snapshot.root, process: lease.host.process })
  return true
}

export function hasOriginatingSettlement(record: OwnerRecord, root: unknown, process: unknown): boolean {
  const origin = originatingSettlements.get(canonicalValueDigest(record))
  return (
    origin?.fence.rootCurrent() === true &&
    canonicalValueDigest(origin.root) === canonicalValueDigest(root) &&
    canonicalValueDigest(origin.process) === canonicalValueDigest(process)
  )
}

function settlementReservations(
  fence: FixExecutionFence,
  publications: readonly FixPublicationObservation[],
  operations: Extract<PreparationCohortResult, { status: 'joined' }>['operations'],
): FixActionResult<Parameters<typeof deriveFixOwnerSettlementFacts>[0]['reservations'][number][]> {
  const reservations: Parameters<typeof deriveFixOwnerSettlementFacts>[0]['reservations'][number][] = []
  for (const identity of fence.outboundReservations()) {
    const parsed = outboundOperationSchema.safeParse({ identity, publication: { state: 'reserved' } })
    if (!parsed.success) return failure('fix-owner-settlement-reservation-invalid')
    const publication = publications.find(
      (item) =>
        item.repository === identity.scope.repository &&
        item.target === identity.scope.target &&
        item.kind === identity.kind &&
        item.recordId === identity.recordId &&
        item.runId === identity.runId &&
        item.operationId === identity.operationId,
    )
    const submitted =
      publication !== undefined &&
      operations.some(
        (operation) => operation.kind === 'gh-append' && operation.attribution === publication.attribution,
      )
    reservations.push({ identity: parsed.data.identity, submitted })
  }
  return { ok: true, value: reservations }
}

function settlementFacts(
  fence: FixExecutionFence,
  opening: Opening,
  prepared: Pick<PreparedFix, 'target'>,
  candidateGitSHA: string,
  host: Extract<PreparationCohortResult, { status: 'joined' }>,
  histories: readonly DecodedHistory[],
) {
  const snapshot = fence.snapshot()
  const qualified = reconcileRecoveryHostEffects({
    host,
    publications: snapshot.publications,
    target: { repository: prepared.target.repository, pr: prepared.target.number, head: candidateGitSHA },
  })
  if (qualified.status !== 'qualified') return failure(...qualified.diagnostics)
  const reserved = settlementReservations(fence, qualified.reservedPublications, host.operations)
  if (!reserved.ok) return reserved
  const facts = deriveFixOwnerSettlementFacts({ opening, reservations: reserved.value, histories })
  if (!facts.ok) return failure(...facts.diagnostics.map((item) => item.code))
  return { ok: true as const, value: facts.value }
}

/** Produce only an originating joined no-entry settlement, never one inferred from journal absence. */
export async function prepareBoundedFixSettlement(input: {
  fence: FixExecutionFence
  opening: Opening
  prepared: Pick<PreparedFix, 'cwd' | 'target' | 'publishBinding'>
  readHistories: () => Promise<FixActionResult<readonly DecodedHistory[]>>
}): Promise<FixActionResult<FixOwnerSettledPayload>> {
  const candidate = await input.fence.observeSealedNoEntry()
  if (candidate.status !== 'candidate') return failure(...candidate.diagnostics)
  const common = input.opening.payload.common
  const lease = input.fence.destinationLeaseFacts()
  if (
    common.host.kind !== 'linux-qualified' ||
    lease?.host === null ||
    lease === null ||
    canonicalValueDigest(common.host.process) !== canonicalValueDigest(lease.host.process) ||
    canonicalValueDigest(common.host.namespace) !== canonicalValueDigest(lease.host.namespace)
  )
    return failure('fix-owner-settlement-host-unqualified')
  const candidateGitSHA = input.prepared.target.candidateGitSHA
  if (
    canonicalValueDigest(candidate.owner) !== canonicalValueDigest(common.owner) ||
    common.pullRequest.repository !== input.prepared.target.repository ||
    common.pullRequest.target !== input.prepared.target.target ||
    candidateGitSHA === null
  )
    return failure('fix-owner-settlement-target-mismatch')
  return input.fence.runSettlement(async () => {
    if (!(await input.fence.recheckSettlementLease())) return failure('fix-owner-settlement-lease-unconfirmed')
    const local = await observeRecoveryGit(input.prepared)
    if (!local.ok) return local
    const histories = await input.readHistories()
    if (!histories.ok) return histories
    const host = await input.fence.joinSettlement()
    if (host.status !== 'joined') return failure('fix-owner-settlement-host-unconfirmed')
    const facts = settlementFacts(input.fence, input.opening, input.prepared, candidateGitSHA, host, histories.value)
    if (!facts.ok) return facts
    if (!(await input.fence.recheckSettlementLease())) return failure('fix-owner-settlement-lease-unconfirmed')
    const { head, remoteHead, statusDigest, clean } = local.value
    const payload: FixOwnerSettledPayload = {
      format: 'omp-build-fix-owner/1',
      phase: 'settled',
      opened: { scope: candidate.owner.scope, kind: 'fix-owner', recordId: candidate.owner.recordId },
      interrupted: facts.value.interrupted,
      admissionSealed: true,
      outbound: facts.value.outbound,
      witness: {
        kind: 'sealed-no-entry',
        hostContract: 'trusted-preparation/1',
        nativeAdmission: 'not-entered',
        correctionPlan: 'not-entered',
        driver: 'joined',
        publications: 'joined',
        git: 'joined',
        hostCallbacks: 'joined',
      },
      local: { head, remoteHead, statusDigest, clean },
    }
    pendingSettlements.set(payload, { fence: input.fence, digest: canonicalValueDigest(payload) })
    return { ok: true, value: payload }
  })
}
