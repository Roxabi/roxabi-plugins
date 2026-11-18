import type { DecodedHistory, GitHubOptions, Scope } from '../dist/contracts.js'
import {
  assessFixOwnerAdmission,
  decodeHistory,
  fixRecoveryDiscoveryScopes,
  projectRecoveryHistories,
  readGitHubHistory,
} from '../dist/contracts.js'
import type { Destination } from '../engine/fix-recovery-schema.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { FixActionResult } from './fix-contract.ts'
import { failure, recoveryDiagnosticStrings } from './fix-contract.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'

/** Collect the fresh raw cut independently of admission, including after a control publication. */
export async function readFixOwnerHistories(input: {
  uw: Scope
  pullRequest: Scope
  github: GitHubOptions
  reader: UwReadPort
}): Promise<FixActionResult<{ current: UwRead; histories: DecodedHistory[] }>> {
  try {
    const current = await input.reader.readUw(input.uw)
    const queue: Scope[] = [input.uw, input.pullRequest, ...current.histories.map((history) => history.source.scope)]
    const visited = new Set<string>()
    const histories: DecodedHistory[] = []
    for (const scope of queue) {
      const key = JSON.stringify([scope.repository, scope.target])
      if (visited.has(key)) continue
      visited.add(key)
      const history = decodeHistory(await readGitHubHistory(scope, input.github))
      histories.push(history)
      const records: CanonicalRecord[] = history.operations.flatMap((operation) =>
        operation.authority !== 'foreign' && operation.status === 'complete' && operation.record !== null
          ? [operation.record]
          : [],
      )
      queue.push(...fixRecoveryDiscoveryScopes(records))
    }
    return { ok: true, value: { current, histories } }
  } catch (error) {
    return failure('fix-owner-admission-observation-failed', error instanceof Error ? error.message : String(error))
  }
}

/** This is a factual observation plus Core's durable gate, not a lease or execution grant. */
export async function observeFixOwnerAdmission(input: {
  uw: Scope
  pullRequest: Scope
  destination: Destination
  intent: 'fresh' | 'recovery'
  github: GitHubOptions
  reader: UwReadPort
}): Promise<
  FixActionResult<{
    admission: Extract<ReturnType<typeof assessFixOwnerAdmission>, { ok: true }>['value']
    histories: DecodedHistory[]
    current: UwRead
  }>
> {
  const read = await readFixOwnerHistories(input)
  if (!read.ok) return read
  const { current, histories } = read.value
  const projected = projectRecoveryHistories(histories)
  if (!projected.ok)
    return failure('fix-owner-admission-projection-refused', ...recoveryDiagnosticStrings(projected.diagnostics))
  const admission = assessFixOwnerAdmission({
    uw: input.uw,
    pullRequest: input.pullRequest,
    destination: input.destination,
    graph: current.graph,
    histories,
    effectiveHistories: projected.value,
    intent: input.intent,
  })
  if (!admission.ok)
    return failure(
      'fix-owner-admission-refused',
      ...recoveryDiagnosticStrings(admission.diagnostics),
      ...(input.intent === 'fresh'
        ? [
            `Inspect this PR with omp_build_recover_interrupted_fix; interrupted or ambiguous owners are not necessarily recoverable.`,
          ]
        : []),
    )
  return { ok: true, value: { admission: admission.value, histories, current } }
}
