import type { BeforeSubagentSpawnEvent } from '@oh-my-pi/pi-coding-agent'
import { type ActiveBatch, spawnRefusal } from './state'

export function nativeSpawnRefusal(active: ActiveBatch | null, event: BeforeSubagentSpawnEvent): string | null {
  if (!active) return null
  if (event.spawnKey === undefined || !active.childSlots.has(event.spawnKey)) return null
  const refusal = spawnRefusal(active, event)
  if (refusal !== null) return refusal
  const index = event.spawnKey === undefined ? undefined : active.childSlots.get(event.spawnKey)
  if (index === undefined || !active.models[index]) return 'native child model route unavailable'
  return null
}
