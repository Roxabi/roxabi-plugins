import type { DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import { bindExternalRef, canonicalValueDigest } from '../dist/contracts.js'
import type { ActionInputManifest } from '../engine/action-input-schema.ts'
import type { AdmissionDescriptor, Destination, FixOwnerHost, RecoveryRef } from '../engine/fix-recovery-schema.ts'
import type { FixActionResult, FixIdentity, FixTarget, PublishBinding } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import type { FixExecutionFence } from './fix-execution-fence.ts'
import { resolveFixOrigin } from './fix-origin.ts'
import { observeFixOwnerAdmission, readFixOwnerHistories } from './fix-owner-admission-observation.ts'
import { publishConfirmedFixOwner } from './fix-owner-publication.ts'
import type { OperatorRequestReservation } from './fix-records.ts'
import type { UwReadPort } from './uw-contract.ts'

function resolveOwnerMandate(
  bindingRef: NonNullable<Extract<ActionInputManifest['subject'], { kind: 'uw' }>['binding']>['record'],
  histories: readonly DecodedHistory[],
  uw: Scope,
) {
  const home = histories.find(
    (history) =>
      history.source.scope.repository === bindingRef.scope.repository &&
      history.source.scope.target === bindingRef.scope.target,
  )
  if (bindingRef.kind !== 'workflow-binding' || home === undefined) return failure('fix-owner-binding-unavailable')
  const binding = bindExternalRef(
    { scope: bindingRef.scope, kind: 'workflow-binding', recordId: bindingRef.recordId },
    home,
  )
  if (!binding.ok || binding.value.kind !== 'workflow-binding') return failure('fix-owner-binding-unavailable')
  const mandate = binding.value.payload.mandate
  if (mandate.kind !== 'mandate' || mandate.scope.repository !== uw.repository || mandate.scope.target !== uw.target)
    return failure('fix-owner-mandate-mismatch')
  return { ok: true as const, value: { ...mandate, kind: 'mandate' as const } }
}

function ownerAuthority(manifest: ActionInputManifest, uw: Scope, target: FixTarget) {
  const { subject, spec } = manifest
  if (
    subject.kind !== 'uw' ||
    subject.binding === null ||
    spec.kind !== 'accepted' ||
    subject.uw.repository !== uw.repository ||
    subject.uw.target !== uw.target ||
    subject.pullRequest === null ||
    subject.pullRequest.repository !== target.repository ||
    subject.pullRequest.target !== target.target
  )
    return failure('fix-owner-action-authority-unavailable')
  return { ok: true as const, value: { subject, binding: subject.binding, spec } }
}

function ownerHost(
  admission: AdmissionDescriptor,
  qualified: Pick<Extract<FixOwnerHost, { kind: 'linux-qualified' }>, 'process' | 'namespace'> | null,
): FixActionResult<FixOwnerHost> {
  const platform = process.platform
  if (platform !== 'linux' && platform !== 'darwin' && platform !== 'win32')
    return failure('fix-owner-platform-unavailable')
  const host: FixOwnerHost =
    qualified !== null && platform === 'linux'
      ? { kind: 'linux-qualified', platform, admission, ...qualified }
      : { kind: 'ordinary-only', platform, admission }
  return { ok: true, value: host }
}

/** Open only after current action preparation and the same destination's under-lease durable gate. */
export async function openFreshFixOwner(input: {
  identity: FixIdentity
  fence: FixExecutionFence
  uw: Scope
  target: FixTarget
  cwd: string
  publishBinding: PublishBinding & { destination: Destination }
  reader: UwReadPort
  github: GitHubOptions
  manifest: ActionInputManifest
  reservation: OperatorRequestReservation
  afterClose: RecoveryRef | null
}): Promise<FixActionResult<void>> {
  const lease = input.fence.destinationLeaseFacts()
  const root = input.fence.snapshot().root
  if (lease === null || root === null || !(await input.fence.recheckDestinationLease()))
    return failure('fix-owner-lease-unconfirmed')
  const authority = ownerAuthority(input.manifest, input.uw, input.target)
  if (!authority.ok) return authority
  const { binding, spec } = authority.value
  const pullRequest = { repository: input.target.repository, target: input.target.target }
  const observed = await observeFixOwnerAdmission({
    uw: input.uw,
    pullRequest,
    destination: input.publishBinding.destination,
    intent: 'fresh',
    github: input.github,
    reader: input.reader,
  })
  const destination = input.publishBinding.destination
  if (
    canonicalValueDigest([destination.authority, destination.publicationRepository, destination.destinationRef]) !==
    lease.descriptor.destinationDigest
  )
    return failure('fix-owner-lease-destination-mismatch')
  const currentOrigin = await resolveFixOrigin(input.uw, input.reader)
  if (!currentOrigin.ok) return currentOrigin
  if (canonicalValueDigest(currentOrigin.value.effective) !== canonicalValueDigest(spec.effective))
    return failure('correction-origin-stale')
  if (!observed.ok) return observed
  if (
    observed.value.admission.status !== 'fresh' ||
    canonicalValueDigest(observed.value.admission.afterClose) !== canonicalValueDigest(input.afterClose)
  )
    return failure('fix-owner-admission-changed')
  const bindingRef = binding.record
  const resolvedMandate = resolveOwnerMandate(bindingRef, observed.value.histories, input.uw)
  if (!resolvedMandate.ok) return resolvedMandate
  const mandate = resolvedMandate.value
  const host = ownerHost(lease.descriptor, lease.host)
  if (!host.ok) return host
  const writeScopes =
    input.uw.repository === pullRequest.repository && input.uw.target === pullRequest.target
      ? [input.uw]
      : [input.uw, pullRequest]
  const opened = await publishConfirmedFixOwner({
    identity: lease.owner,
    github: input.github,
    histories: observed.value.histories,
    fence: input.fence,
    payload: {
      format: 'omp-build-fix-owner/1',
      phase: 'opened',
      common: {
        owner: lease.owner,
        operationPrefix: input.identity.operationId,
        host: host.value,
        root,
        destination: input.publishBinding.destination,
        uw: input.uw,
        pullRequest,
        writeScopes,
        mandate: { scope: mandate.scope, kind: mandate.kind, recordId: mandate.recordId },
        binding: { scope: bindingRef.scope, kind: 'workflow-binding', recordId: bindingRef.recordId },
        plugin: input.manifest.plugin,
        configuration: input.manifest.configuration,
        accepted: spec.effective,
        acceptedDigest: canonicalValueDigest(spec.effective),
      },
      intent: {
        kind: 'fresh-intake',
        afterClose: input.afterClose,
        sourceReservation: input.reservation.source,
        requestReservation: input.reservation.request,
      },
    },
    settlementBasis: {
      prepared: { cwd: input.cwd, target: input.target, publishBinding: input.publishBinding },
      readHistories: async () => {
        const result = await readFixOwnerHistories({
          uw: input.uw,
          pullRequest,
          github: input.github,
          reader: input.reader,
        })
        return result.ok ? { ok: true, value: result.value.histories } : result
      },
    },
  })
  return opened.ok ? { ok: true, value: undefined } : opened
}
