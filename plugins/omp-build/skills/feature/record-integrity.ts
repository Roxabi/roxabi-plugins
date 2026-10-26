import { NATIVE_INSTANT, type PrComment, type Producer, type Refusal, refuse } from './proof-base'

/** GitHub's native UTC instants, including a real calendar date; no inferred timestamp. */
export function nativeInstant(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !NATIVE_INSTANT.test(value)) return null
  const time = Date.parse(value)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== value.slice(0, 19)) return null
  return time
}

/** Acquisition only creates parts: a readable native revision invalidates reuse. */
export function recordIntegrity(parts: PrComment[], producer: Producer): Refusal | null {
  for (const [index, part] of parts.entries()) {
    const created = nativeInstant(part.createdAt)
    const revised = nativeInstant(part.updatedAt)
    if (created === null || revised === null || revised < created) {
      return refuse(
        producer,
        'unreadable',
        `proof part ${index + 1}/${parts.length} has unreadable native creation/revision facts (${JSON.stringify(part.createdAt)}, ${JSON.stringify(part.updatedAt)}); obtain readable GitHub metadata before re-review`,
      )
    }
    if (revised !== created) {
      return refuse(
        producer,
        'unbound',
        `proof part ${index + 1}/${parts.length} was revised after publication; acquire a new producer record, then review the head (skills/feature/proof-records.ts recordIntegrity)`,
      )
    }
  }
  return null
}
