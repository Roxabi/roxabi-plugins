import { randomUUID } from 'node:crypto'
import type { CanonicalRecord, DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import {
  bindExternalRef,
  canonicalValueDigest,
  decodeHistory,
  publishGitHubRecord,
  readGitHubHistory,
} from '../dist/contracts.js'
import { validateOriginatingFixSettlement } from '../engine/fix-originating-settlement.ts'
import type { ReservedRecordIdentity } from '../engine/fix-recovery-identities.ts'
import type { FixOwnerOpenedPayload, FixOwnerPayload, FixOwnerSettledPayload } from '../engine/fix-recovery-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { FixActionResult, PreparedFix } from './fix-contract.ts'
import { failure, recoveryDiagnosticStrings } from './fix-contract.ts'
import type { FixExecutionFence } from './fix-execution-fence.ts'
import {
  authorizePendingOriginatingSettlement,
  confirmOriginatingSettlement,
  prepareBoundedFixSettlement,
} from './fix-owner-settlement.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { createGitHubRecordPublisher } from './github-publisher.ts'

type OwnerRecord = Extract<CanonicalRecord, { kind: 'fix-owner' }>
type SettlementBasis = {
  prepared: Pick<PreparedFix, 'cwd' | 'target' | 'publishBinding'>
  readHistories: () => Promise<FixActionResult<readonly DecodedHistory[]>>
}

async function settlementPublicationContext(
  record: CanonicalRecord,
  history: DecodedHistory,
  expected: OwnerRecord,
  payload: FixOwnerSettledPayload,
  fence: FixExecutionFence,
  scopes: readonly Scope[],
  options: GitHubOptions,
) {
  if (
    record.kind !== 'fix-owner' ||
    canonicalValueDigest(record) !== canonicalValueDigest(expected) ||
    !(await authorizePendingOriginatingSettlement(fence, payload, record))
  )
    return {
      ok: false as const,
      diagnostics: [
        {
          code: 'fix-owner-settlement-origin-unconfirmed',
          message: 'Originating settlement capability or lease is unavailable',
        },
      ],
    }
  const fresh = await Promise.all(scopes.map(async (scope) => decodeHistory(await readGitHubHistory(scope, options))))
  const home = fresh.filter(
    (item) =>
      item.source.scope.repository === history.source.scope.repository &&
      item.source.scope.target === history.source.scope.target,
  )
  const homeHistory = home[0]
  if (
    home.length !== 1 ||
    homeHistory === undefined ||
    canonicalValueDigest(homeHistory.source) !== canonicalValueDigest(history.source)
  )
    return {
      ok: false as const,
      diagnostics: [{ code: 'ambiguous', message: 'Settlement publication source changed during native observation' }],
    }
  const checked = validateOriginatingFixSettlement({ record, histories: fresh })
  if (!checked.ok) return checked
  if (!(await authorizePendingOriginatingSettlement(fence, payload, record)))
    return {
      ok: false as const,
      diagnostics: [
        {
          code: 'fix-owner-settlement-origin-unconfirmed',
          message: 'Originating settlement capability or lease changed during native observation',
        },
      ],
    }
  return { ok: true as const, value: { config: null, externalHistories: fresh.filter((item) => item !== homeHistory) } }
}

function bindOpenedSettlement(
  fence: FixExecutionFence,
  opening: OwnerRecord & { payload: FixOwnerOpenedPayload },
  identity: ReservedRecordIdentity<'fix-owner'>,
  basis: SettlementBasis,
  github: GitHubOptions,
): void {
  fence.bindOwnerSettlement(async () => {
    const settled = await prepareBoundedFixSettlement({ fence, opening, ...basis })
    if (!settled.ok) return settled
    return fence.runSettlement(async () => {
      const recordId = `fix-owner-${randomUUID()}`
      const settlementIdentity: ReservedRecordIdentity<'fix-owner'> = {
        scope: identity.scope,
        kind: 'fix-owner',
        runId: identity.runId,
        operationId: `${opening.payload.common.operationPrefix}-${recordId}`,
        recordId,
      }
      fence.enrollPublicationReservation(settlementIdentity)
      const histories = await basis.readHistories()
      if (!histories.ok) return histories
      const published = await publishConfirmedFixOwner({
        identity: settlementIdentity,
        payload: settled.value,
        github,
        histories: histories.value,
        fence,
      })
      return published.ok ? { ok: true } : published
    })
  })
}

async function confirmOpenedReadback(
  fence: FixExecutionFence,
  bound: OwnerRecord,
  identity: ReservedRecordIdentity<'fix-owner'>,
  basis: SettlementBasis | undefined,
  github: GitHubOptions,
): Promise<FixActionResult<void>> {
  if (!(await fence.recheckDestinationLease())) return failure('fix-destination-lease-lost-after-owner-readback')
  fence.confirmOpenedOwner(identity)
  if (bound.payload.phase !== 'opened') return failure('fix-owner-readback-unconfirmed')
  if (basis === undefined) return failure('fix-owner-settlement-basis-unavailable')
  bindOpenedSettlement(fence, { ...bound, payload: bound.payload }, identity, basis, github)
  return { ok: true, value: undefined }
}

function validateOwnerPublication(
  payload: FixOwnerPayload,
  basis: SettlementBasis | undefined,
  identity: ReservedRecordIdentity<'fix-owner'>,
): FixActionResult<void> {
  if (payload.phase === 'opened' && basis === undefined) return failure('fix-owner-settlement-basis-unavailable')
  if (payload.phase === 'opened' && canonicalValueDigest(payload.common.owner) !== canonicalValueDigest(identity))
    return failure('fix-owner-reservation-mismatch')
  return { ok: true, value: undefined }
}

/**
 * Publish one already-authorized owner envelope and authenticate its exact readback.
 * This is a persistence boundary, not an owner admission or recovery policy.
 */
export async function publishConfirmedFixOwner(input: {
  identity: ReservedRecordIdentity<'fix-owner'>
  payload: FixOwnerPayload
  github: GitHubOptions
  histories: readonly DecodedHistory[]
  fence: FixExecutionFence
  settlementBasis?: SettlementBasis
}): Promise<FixActionResult<Extract<CanonicalRecord, { kind: 'fix-owner' }>>> {
  const { identity, payload, fence, settlementBasis } = input
  const validation = validateOwnerPublication(payload, settlementBasis, identity)
  if (!validation.ok) return validation
  if (payload.phase === 'opened' && !(await fence.recheckDestinationLease()))
    return failure('fix-destination-lease-unconfirmed')
  const built = buildRecord({
    version: 1,
    kind: 'fix-owner',
    repository: identity.scope.repository,
    target: identity.scope.target,
    recordId: identity.recordId,
    runId: identity.runId,
    operationId: identity.operationId,
    payload,
  })
  if (!built.ok) return failure(...built.diagnostics.map((item) => item.code))
  const publication =
    payload.phase === 'opened'
      ? await fence.trackPublication(built.value, () =>
          createGitHubRecordPublisher(identity.scope, input.github, null).publish(built.value, input.histories, () =>
            fence.rootCurrent(),
          ),
        )
      : await fence.trackPublication(built.value, async () => {
          const expected = built.value
          const options = withRoxabiGitHubPolicy({ ...input.github, canPublish: () => fence.rootCurrent() })
          const scopes = input.histories.map((history) => history.source.scope)
          const result = await publishGitHubRecord(
            expected,
            options,
            ({ record, history }) =>
              settlementPublicationContext(record, history, expected, payload, fence, scopes, options),
            input.histories,
          )
          return result.status === 'confirmed'
            ? { ok: true as const }
            : failure(...recoveryDiagnosticStrings(result.diagnostics))
        })
  if (!publication.ok) return publication
  if (payload.phase === 'opened' && !(await fence.recheckDestinationLease()))
    return failure('fix-destination-lease-lost-after-owner-publication')
  let history: DecodedHistory
  try {
    history = decodeHistory(await readGitHubHistory(identity.scope, input.github))
  } catch {
    return failure('fix-owner-readback-unavailable')
  }
  const bound = bindExternalRef({ scope: identity.scope, kind: 'fix-owner', recordId: identity.recordId }, history)
  if (
    !bound.ok ||
    bound.value.kind !== 'fix-owner' ||
    canonicalValueDigest(bound.value) !== canonicalValueDigest(built.value)
  )
    return failure('fix-owner-readback-unconfirmed')
  if (payload.phase === 'opened') {
    const confirmed = await confirmOpenedReadback(fence, bound.value, identity, settlementBasis, input.github)
    if (!confirmed.ok) return confirmed
  } else if (!(await confirmOriginatingSettlement(fence, payload, bound.value))) {
    return failure('fix-owner-settlement-origin-unconfirmed')
  }
  return { ok: true, value: bound.value }
}
