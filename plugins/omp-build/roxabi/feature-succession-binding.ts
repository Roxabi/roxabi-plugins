// Source: plugins/omp-build/roxabi/workflow.ts:1089-1139,1360-1419
import { randomUUID } from 'node:crypto'
import {
  type Contracts,
  type History,
  type HistoryRecord,
  isRecord,
  publishRecord,
  type Scope,
} from './feature-engine.ts'

export type Gh = (cwd: string, args: string[]) => Promise<string>

type DeliveryPr = { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED' }

async function discoverDeliveryPr(
  gh: Gh,
  cwd: string,
  head: string,
  base: string,
): Promise<{ ok: true; number: number | null } | { ok: false; reason: string }> {
  const raw = await deliveryPrOutput(gh, cwd, head, base)
  if (!raw.ok) return raw
  const parsed = deliveryPrs(raw.raw)
  if (!parsed.ok) return parsed
  return deliveryPrResult(parsed.prs)
}

async function deliveryPrOutput(
  gh: Gh,
  cwd: string,
  head: string,
  base: string,
): Promise<{ ok: true; raw: string } | { ok: false; reason: string }> {
  try {
    return {
      ok: true,
      raw: await gh(cwd, [
        'pr',
        'list',
        '--head',
        head,
        '--base',
        base,
        '--state',
        'all',
        '--limit',
        '30',
        '--json',
        'number,isCrossRepository,state',
      ]),
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'pr-discovery-failed' }
  }
}

function deliveryPrs(raw: string): { ok: true; prs: DeliveryPr[] } | { ok: false; reason: string } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'pr-discovery-unreadable' }
  }
  if (!Array.isArray(data)) return { ok: false, reason: 'pr-discovery-unreadable' }
  if (data.length >= 30) return { ok: false, reason: 'pr-discovery-incomplete' }
  const prs: DeliveryPr[] = []
  for (const entry of data) {
    const pr = deliveryPr(entry)
    if (pr === null) return { ok: false, reason: 'pr-discovery-unreadable' }
    if (pr.sameRepository) prs.push({ number: pr.number, state: pr.state })
  }
  return { ok: true, prs }
}

function deliveryPr(value: unknown): (DeliveryPr & { sameRepository: boolean }) | null {
  if (!isRecord(value) || typeof value.isCrossRepository !== 'boolean') return null
  if (typeof value.number !== 'number' || !Number.isInteger(value.number) || value.number <= 0) return null
  if (value.state !== 'OPEN' && value.state !== 'MERGED' && value.state !== 'CLOSED') return null
  return { number: value.number, state: value.state, sameRepository: !value.isCrossRepository }
}

function deliveryPrResult(
  prs: readonly DeliveryPr[],
): { ok: true; number: number | null } | { ok: false; reason: string } {
  if (prs.length > 1) return { ok: false, reason: 'pr-discovery-ambiguous' }
  if (prs[0]?.state === 'CLOSED') return { ok: false, reason: 'pr-discovery-closed' }
  return { ok: true, number: prs[0]?.number ?? null }
}

export async function preserveSuccessorBinding(input: {
  loaded: Contracts
  gh: Gh
  cwd: string
  issueHistory: History
  successorId: string
  successorScope: Scope
  antecedentRecordId: string
  branch: string
  base: string
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const discovered = await discoverDeliveryPr(input.gh, input.cwd, input.branch, input.base)
  if (!discovered.ok) return discovered
  if (discovered.number === null) return { ok: true }
  const prScope = input.loaded.githubScope(input.successorScope.repository, discovered.number)
  const read = await input.loaded.readComposedWorkflowHistory([prScope], { cwd: input.cwd, gh: input.gh })
  if (!read.ok || !read.histories[0]) return { ok: false, reason: read.ok ? 'binding-incomplete' : read.reason }
  const prHistory = read.histories[0]
  const bindings = prHistory.operations.flatMap((operation) => {
    const record = operation.record
    if (operation.status !== 'complete' || record?.kind !== 'workflow-binding') return []
    const mandate = record.payload.mandate
    if (!isRecord(mandate) || typeof mandate.recordId !== 'string') return []
    return [mandate.recordId]
  })
  if (bindings.includes(input.successorId)) return { ok: true }
  const namesAntecedent = bindings.includes(input.antecedentRecordId)
  if (bindings.some((id) => id !== input.antecedentRecordId && id !== input.successorId))
    return { ok: false, reason: 'binding-conflict' }
  if (bindings.length > 0 && !namesAntecedent) return { ok: false, reason: 'binding-conflict' }
  const recordId = randomUUID()
  const binding = {
    repository: prScope.repository,
    target: prScope.target,
    version: 1 as const,
    recordId,
    runId: recordId,
    operationId: recordId,
    kind: 'workflow-binding' as const,
    payload: {
      mandate: { scope: input.successorScope, recordId: input.successorId, kind: 'mandate' as const },
      branch: input.branch,
      base: input.base,
    },
  } satisfies Omit<Extract<HistoryRecord, { kind: 'workflow-binding' }>, 'inputs'>
  return publishRecord(input.loaded, prHistory, binding, input.gh, input.cwd, [input.issueHistory])
}
