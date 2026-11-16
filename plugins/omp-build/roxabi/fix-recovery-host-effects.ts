import type { PreparationCohortResult } from '../host/preparation-cohort.ts'
import type { FixPublicationObservation } from './fix-fence-operations.ts'

type HostEffectInput = {
  host: Extract<PreparationCohortResult, { status: 'joined' }>
  publications: readonly FixPublicationObservation[]
  target: { repository: string; pr: number; head: string }
}

function matchingReceipt(input: HostEffectInput, operation: HostEffectInput['host']['operations'][number]) {
  return operation.attribution === undefined
    ? undefined
    : input.host.disarmConfirmations.find(
        (item) =>
          item.attribution === operation.attribution &&
          item.repository === input.target.repository &&
          item.pr === input.target.pr &&
          item.head === input.target.head,
      )
}

function hasMatchingReservation(
  reservations: readonly FixPublicationObservation[],
  operation: HostEffectInput['host']['operations'][number],
): boolean {
  return (
    operation.attribution !== undefined &&
    reservations.some((publication) => publication.attribution === operation.attribution)
  )
}

/** Qualifies only attributed host mutation outcomes. Reserved appends still require Core cut reconstruction. */
export function reconcileRecoveryHostEffects(
  input: HostEffectInput,
):
  | { status: 'qualified'; reservedPublications: readonly FixPublicationObservation[] }
  | { status: 'held'; diagnostics: string[] } {
  const reservations = input.publications.filter((publication) => publication.reserved)
  if (input.publications.some((publication) => !publication.reserved || publication.outcome === 'pending'))
    return { status: 'held', diagnostics: ['fix-host-publication-unattributed'] }
  for (const [index, operation] of input.host.operations.entries()) {
    if (operation.kind !== 'gh-write' && operation.kind !== 'gh-append') continue
    const receipt = matchingReceipt(input, operation)
    const held = (code: string) => ({
      status: 'held' as const,
      diagnostics: [
        code,
        `fix-host-effect-detail:${JSON.stringify({
          index,
          kind: operation.kind,
          outcome: operation.outcome,
          provenance: operation.provenance ?? null,
          target: input.target,
          hasAttribution: operation.attribution !== undefined,
          matchingPublications: reservations.flatMap((publication, position) =>
            operation.attribution !== undefined && publication.attribution === operation.attribution ? [position] : [],
          ),
          receipts: input.host.disarmConfirmations.map((item) => ({
            repository: item.repository,
            pr: item.pr,
            head: item.head,
            attributionMatches: operation.attribution !== undefined && item.attribution === operation.attribution,
            authorized: item.authorizationReceiptId !== null,
          })),
        })}`,
      ],
    })
    if (operation.kind === 'gh-write') {
      if (receipt === undefined) return held('fix-host-write-unattributed')
      continue
    }
    const reserved = hasMatchingReservation(reservations, operation)
    if (
      !reserved &&
      (receipt === undefined || (operation.outcome === 'rejected' && receipt.authorizationReceiptId === null))
    )
      return held('fix-host-append-unattributed')
  }
  return { status: 'qualified', reservedPublications: reservations }
}
