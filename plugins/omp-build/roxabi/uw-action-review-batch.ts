import { canonicalValueDigest } from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import type {
  CurrentActionFacts,
  PreparedUwAction,
  ReviewActionBatch,
  UwActionPorts,
  UwActionRequest,
} from './uw-action-contract.ts'
import { prepareUwAction, replayUwActionInputs } from './uw-action-inputs.ts'
import { actionFailure } from './uw-action-result.ts'
import { verifyActionSnapshot } from './uw-action-snapshot.ts'

/** Private material captured during exactly one preparation or confirmation cut. */
function capturedPorts(ports: UwActionPorts, facts: ReadonlyMap<string, CurrentActionFacts>): UwActionPorts {
  function capture<K, V>(read: (key: K) => Promise<Result<V>>): (key: K) => Promise<Result<V>> {
    const observed = new Map<string, Promise<Result<V>>>()
    return (key) => {
      const identity = canonicalValueDigest(key)
      const existing = observed.get(identity)
      if (existing !== undefined) return existing
      const value = read(key)
      observed.set(identity, value)
      return value
    }
  }
  let pin: ReturnType<UwActionPorts['plugin']['resolveInstalledPluginPin']> | undefined
  const record = capture(ports.readRecord)
  const records = capture(ports.readRecords)
  const accounted = ports.readAccountedRecord === undefined ? undefined : capture(ports.readAccountedRecord)
  const pinned = capture(ports.readPinnedFile)
  const pinnedFiles = ports.readPinnedFiles === undefined ? undefined : capture(ports.readPinnedFiles)
  const diff = capture(ports.readCodeDiff)
  const installed = capture(ports.plugin.readInstalledFile)
  const references = new Map<string, ReturnType<UwActionPorts['repositoryReferences']>>()
  return {
    ...ports,
    readCurrentActionFacts: async (request) => {
      const value = facts.get(request.actionId)
      return value === undefined
        ? actionFailure('action-input-missing', 'Review action is absent from the captured observation')
        : { ok: true, value }
    },
    readRecord: record,
    readRecords: records,
    ...(accounted === undefined ? {} : { readAccountedRecord: accounted }),
    readPinnedFile: pinned,
    ...(pinnedFiles === undefined ? {} : { readPinnedFiles: pinnedFiles }),
    readCodeDiff: diff,
    repositoryReferences: (request, plannedPaths) => {
      const key = canonicalValueDigest({ code: request.code, purpose: request.purpose, plannedPaths })
      let value = references.get(key)
      if (value === undefined) {
        value = ports.repositoryReferences(request, plannedPaths)
        references.set(key, value)
      }
      return value
    },
    plugin: {
      resolveInstalledPluginPin: () => (pin ??= ports.plugin.resolveInstalledPluginPin()),
      readInstalledFile: installed,
    },
  }
}

function isPanel(item: ReviewActionBatch['actions'][number]): boolean {
  const panel = /^panel-(\d+)-(.+)$/.exec(item.projection.taskName)
  return panel !== null && Number(panel[1]) === item.projection.assignedChunk
}

function validateBatch(input: ReviewActionBatch): Result<readonly UwActionRequest[]> {
  const first = input.actions[0]
  if (first === undefined) return actionFailure('action-input-missing', 'Initial review batch is empty')
  if (first.projection.taskName !== 'spec' || first.projection.assignedChunk !== null)
    return actionFailure('action-input-missing', 'Initial review batch must start with the spec role')
  const common = (request: UwActionRequest) => canonicalValueDigest({ ...request, actionId: '' })
  const projection = (item: typeof first) =>
    canonicalValueDigest({ contextWindow: item.projection.contextWindow, chunks: item.projection.chunks })
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const item of input.actions) {
    if (
      item.request.purpose !== 'review' ||
      common(item.request) !== common(first.request) ||
      projection(item) !== projection(first)
    )
      return actionFailure('review-input-changed', 'Initial review batch inputs differ')
    if (item !== first && !isPanel(item))
      return actionFailure('action-input-missing', 'Initial review batch contains a non-panel role')
    if (ids.has(item.request.actionId) || names.has(item.projection.taskName))
      return actionFailure('action-input-cycle', 'Initial review batch repeats an action or task')
    ids.add(item.request.actionId)
    names.add(item.projection.taskName)
  }
  return { ok: true, value: input.actions.map((item) => item.request) }
}

async function captureFacts(
  ports: UwActionPorts,
  requests: readonly UwActionRequest[],
  fingerprint?: string,
): Promise<Result<ReadonlyMap<string, CurrentActionFacts>>> {
  if (ports.readCurrentActionFactsBatch === undefined)
    return actionFailure('action-input-missing', 'Initial review batch observation is unavailable')
  const result = await ports.readCurrentActionFactsBatch(requests, fingerprint)
  if (!result.ok) return result
  if (result.value.length !== requests.length)
    return actionFailure('record-unreadable', 'Initial review batch observation is incomplete')
  const facts = new Map<string, CurrentActionFacts>()
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i]
    const value = result.value[i]
    if (request === undefined || value === undefined || request.actionId !== value.actionId)
      return actionFailure('record-unreadable', 'Initial review batch observation identity differs')
    facts.set(request.actionId, value.facts)
  }
  return { ok: true, value: facts }
}

async function confirmBatch(
  prepared: readonly PreparedUwAction[],
  requests: readonly UwActionRequest[],
  confirmation: UwActionPorts,
): Promise<Result<true>> {
  for (let i = 0; i < prepared.length; i++) {
    const action = prepared[i]
    const request = requests[i]
    if (action === undefined || request === undefined)
      return actionFailure('record-unreadable', 'Initial review batch is incomplete')
    const replay = await replayUwActionInputs({ reviewed: action.inputs, request }, confirmation)
    if (!replay.ok) return replay
    if (canonicalValueDigest(replay.value) !== canonicalValueDigest(action.inputs))
      return actionFailure('review-input-changed', 'Confirmed review action inputs diverged')
    const verified = await verifyActionSnapshot(action.snapshot)
    if (!verified.ok) return verified
  }
  return { ok: true, value: true }
}

export async function prepareReviewActions(
  input: ReviewActionBatch,
  ports: UwActionPorts,
): Promise<Result<readonly PreparedUwAction[]>> {
  const requests = validateBatch(input)
  if (!requests.ok) return requests
  const observed = await captureFacts(ports, requests.value)
  if (!observed.ok) return observed
  const preparation = capturedPorts(ports, observed.value)
  const prepared: PreparedUwAction[] = []
  for (const item of input.actions) {
    const result = await prepareUwAction(item.request, preparation, item.projection)
    if (!result.ok) return result
    if (prepared.length > 0 && canonicalValueDigest(result.value.inputs) !== canonicalValueDigest(prepared[0]?.inputs))
      return actionFailure('review-input-changed', 'Initial review action inputs diverged')
    prepared.push(result.value)
  }
  const first = prepared[0]
  if (first === undefined) return actionFailure('action-input-missing', 'Initial review batch is empty')
  const confirmed = await captureFacts(ports, requests.value, first.inputs.fingerprint)
  if (!confirmed.ok) return confirmed
  const confirmation = capturedPorts(ports, confirmed.value)
  const replayed = await confirmBatch(prepared, requests.value, confirmation)
  if (!replayed.ok) return replayed
  return { ok: true, value: prepared }
}
