import { canonicalValueDigest } from '../dist/contracts.js'
import type { ReservedRecordIdentity } from '../engine/fix-recovery-identities.ts'
import type { Destination, LatchNamespace } from '../engine/fix-recovery-schema.ts'
import {
  acquireDestinationAdmissionLease,
  releaseDestinationAdmissionLease,
} from '../omp/review-runtime/destination-admission-lease.ts'
import { observeCurrentLinuxHost } from '../omp/review-runtime/linux-execution-lease.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import type { FixExecutionFence } from './fix-execution-fence.ts'

/** Acquire the common destination mutex; Linux observation qualifies recovery only. */
export async function acquireFixOwnerLease(input: {
  destination: Destination
  owner: ReservedRecordIdentity<'fix-owner'>
  priorNamespace: LatchNamespace | null
  fence: FixExecutionFence
}): Promise<FixActionResult<NonNullable<ReturnType<FixExecutionFence['destinationLeaseFacts']>>>> {
  try {
    input.fence.enrollPublicationReservation(input.owner)
  } catch (error) {
    return failure('fix-owner-reservation-invalid', error instanceof Error ? error.message : String(error))
  }
  const acquired = await acquireDestinationAdmissionLease({ destination: input.destination })
  if (acquired.status !== 'acquired')
    return failure(`fix-destination-lease-${acquired.status}`, ...acquired.diagnostics.map((item) => item.code))
  const observed = await observeCurrentLinuxHost()
  const descriptorNamespace = acquired.lease.descriptor.namespace
  const host =
    observed.status === 'qualified' &&
    descriptorNamespace.kind === 'linux-abstract' &&
    observed.namespace.networkNamespace === descriptorNamespace.networkNamespace &&
    (input.priorNamespace === null ||
      canonicalValueDigest(observed.namespace) === canonicalValueDigest(input.priorNamespace))
      ? { process: observed.process, namespace: observed.namespace }
      : null
  try {
    const facts = input.fence.bindDestinationLease(acquired.lease, input.owner, host)
    return { ok: true, value: facts }
  } catch (error) {
    const released = await releaseDestinationAdmissionLease(acquired.lease)
    return failure(
      'fix-destination-lease-bind-failed',
      error instanceof Error ? error.message : String(error),
      ...(released.status === 'released' ? [] : released.diagnostics.map((item) => item.code)),
    )
  }
}
