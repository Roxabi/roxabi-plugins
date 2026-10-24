import type { NativeBatchResult, NativeTask } from '../omp/review-runtime/contracts.ts'
import type { FixActionResult, FixIdentity, FixRecord, PreparedFix, RecordPublisher } from './fix-contract.ts'
import { failure } from './fix-contract.ts'
import { publish, record } from './fix-records.ts'
import { nativeContributionPayload } from './native-contribution'

export type FixIntakePublication = {
  records: FixRecord[]
  complete: boolean
  diagnostics: string[]
}

export type NativeTaskSlot = {
  slotId: string
  phase: 'intake' | 'synthesis' | 'fix' | 'falsification'
  role: string
  chunk: null
  required: true
  output: 'findings' | 'decision' | 'action-result'
  classId: null
  sourceFindingIds: string[]
}

export function taskSlot(
  task: NativeTask,
  phase: 'intake' | 'synthesis' | 'fix' | 'falsification',
  output: 'findings' | 'decision' | 'action-result',
): NativeTaskSlot {
  return {
    slotId: task.name,
    phase,
    role: task.agent,
    chunk: null,
    required: true,
    output,
    classId: null,
    sourceFindingIds: [],
  }
}

function observeNativeChild(
  child: NativeBatchResult['children'][number],
  expectedSlots: Map<string, NativeTaskSlot>,
  observedExpectedIds: Set<string>,
  observedChildIds: Set<string>,
  diagnostics: string[],
) {
  const expectedId = child.expectedId
  const knownExpected = expectedId !== null && expectedSlots.has(expectedId) && !observedExpectedIds.has(expectedId)
  const knownChild = child.id !== null && !observedChildIds.has(child.id)
  if (child.id === null) diagnostics.push('native-child-id-missing')
  else if (observedChildIds.has(child.id)) diagnostics.push(`native-child-id-duplicate:${child.id}`)
  if (expectedId === null) diagnostics.push('native-child-association-missing')
  else if (!expectedSlots.has(expectedId)) diagnostics.push(`native-slot-unknown:${expectedId}`)
  else if (observedExpectedIds.has(expectedId)) diagnostics.push(`native-slot-duplicate:${expectedId}`)
  if (child.id !== null) observedChildIds.add(child.id)
  if (expectedId !== null) observedExpectedIds.add(expectedId)
  return knownExpected && knownChild && expectedId !== null ? (expectedSlots.get(expectedId) ?? null) : null
}

async function publishNativeContribution(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  inventoryId: string,
  output: 'findings' | 'decision' | 'action-result',
  contextInputs: readonly string[],
  slot: NativeTaskSlot | null,
  child: NativeBatchResult['children'][number],
): Promise<FixActionResult<FixRecord>> {
  const contributionId = identity.nextRecordId('contribution')
  const contribution = record(
    identity,
    prepared.target,
    'contribution',
    nativeContributionPayload(slot, child, inventoryId, contributionId, output),
    contextInputs,
    contributionId,
  )
  return publish(publisher, contribution)
}

export async function publishNativeContributions(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  inventoryId: string,
  tasks: readonly NativeTask[],
  phase: 'intake' | 'synthesis' | 'fix' | 'falsification',
  output: 'findings' | 'decision' | 'action-result',
  contextInputs: readonly string[],
  result: NativeBatchResult,
): Promise<FixActionResult<FixRecord[]>> {
  if (result.batch.operationId !== identity.operationId) return failure('native-batch-operation-mismatch')
  const byExpectedId = new Map(tasks.map((task) => [task.name, taskSlot(task, phase, output)]))
  const observedExpectedIds = new Set<string>()
  const observedChildIds = new Set<string>()
  const diagnostics: string[] = []
  const records: FixRecord[] = []
  for (const child of result.children) {
    const slot = observeNativeChild(child, byExpectedId, observedExpectedIds, observedChildIds, diagnostics)
    const saved = await publishNativeContribution(
      prepared,
      identity,
      publisher,
      inventoryId,
      output,
      contextInputs,
      slot,
      child,
    )
    if (saved.ok) records.push(saved.value)
    else diagnostics.push(...saved.diagnostics.map((diagnostic) => `native-contribution-publish:${diagnostic}`))
  }
  for (const task of tasks)
    if (!observedExpectedIds.has(task.name)) diagnostics.push(`native-slot-missing:${task.name}`)
  if (!result.complete) diagnostics.push('native-batch-incomplete')
  return diagnostics.some((diagnostic) => diagnostic.startsWith('native-contribution-publish:'))
    ? failure(...diagnostics)
    : { ok: true, value: records }
}

export function assessFixIntake(
  prepared: PreparedFix,
  result: NativeBatchResult,
  records: FixRecord[],
): FixIntakePublication {
  const expected = new Set(prepared.batch.tasks.tasks.map((task) => task.name))
  const seenExpected = new Set(
    result.children.map((child) => child.expectedId).filter((id): id is string => id !== null),
  )
  const diagnostics = [
    ...[...expected].filter((id) => !seenExpected.has(id)).map((id) => `native-intake-slot-missing:${id}`),
    ...result.children.flatMap((child, index) => [
      ...(child.id === null ? ['native-intake-child-id-missing'] : []),
      ...(child.expectedId === null ? ['native-intake-child-association-missing'] : []),
      ...(child.expectedId !== null && !expected.has(child.expectedId)
        ? [`native-intake-slot-unknown:${child.expectedId}`]
        : []),
      ...(child.expectedId !== null &&
      result.children.findIndex((candidate) => candidate.expectedId === child.expectedId) !== index
        ? [`native-intake-slot-duplicate:${child.expectedId}`]
        : []),
      ...(child.id !== null && result.children.findIndex((candidate) => candidate.id === child.id) !== index
        ? [`native-intake-child-id-duplicate:${child.id}`]
        : []),
    ]),
    ...(result.complete ? [] : ['native-intake-incomplete']),
  ]
  return { records, complete: diagnostics.length === 0, diagnostics }
}

/** Preserve every native original before refusing incomplete, duplicate, or unknown intake results. */
export async function publishFixIntake(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  result: NativeBatchResult,
): Promise<FixActionResult<FixIntakePublication>> {
  const records = await publishNativeContributions(
    prepared,
    identity,
    publisher,
    prepared.inventoryId,
    prepared.batch.tasks.tasks,
    'intake',
    'findings',
    [prepared.inventoryId],
    result,
  )
  return records.ok ? { ok: true, value: assessFixIntake(prepared, result, records.value) } : records
}
