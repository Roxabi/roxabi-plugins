import type { Gh } from '../adapters/github/types.ts'
import { isRecord } from './feature-engine.ts'

type DeliveryPrDiscovery = { ok: true; number: number | null } | { ok: false; reason: string }

function discoveredPullRequest(data: unknown): DeliveryPrDiscovery {
  if (!Array.isArray(data)) return { ok: false, reason: 'pr-discovery-unreadable' }
  if (data.length >= 30) return { ok: false, reason: 'pr-discovery-incomplete' }
  const same: { number: number; state: string }[] = []
  for (const entry of data) {
    if (
      !isRecord(entry) ||
      typeof entry.isCrossRepository !== 'boolean' ||
      typeof entry.number !== 'number' ||
      !Number.isInteger(entry.number) ||
      entry.number <= 0 ||
      (entry.state !== 'OPEN' && entry.state !== 'MERGED' && entry.state !== 'CLOSED')
    ) {
      return { ok: false, reason: 'pr-discovery-unreadable' }
    }
    if (!entry.isCrossRepository) same.push({ number: entry.number, state: entry.state })
  }
  if (same.length > 1) return { ok: false, reason: 'pr-discovery-ambiguous' }
  if (same[0]?.state === 'CLOSED') return { ok: false, reason: 'pr-discovery-closed' }
  return { ok: true, number: same[0]?.number ?? null }
}

export async function discoverDeliveryPr(
  gh: Gh,
  cwd: string,
  head: string,
  base: string,
): Promise<DeliveryPrDiscovery> {
  let raw: string
  try {
    raw = await gh(cwd, [
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
    ])
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'pr-discovery-failed' }
  }
  try {
    return discoveredPullRequest(JSON.parse(raw))
  } catch {
    return { ok: false, reason: 'pr-discovery-unreadable' }
  }
}
