/**
 * Generic topological sort (Kahn's algorithm).
 *
 * @param ids        - nodes to sort (must include all nodes referenced by getUpstream)
 * @param getUpstream - returns the ids that must be emitted before `id` (its upstream / blockers)
 * @param tieBreak   - 'string-asc': sort ready batch by default JS comparator (lexicographic) each
 *                     round, cycle dump same — legacy parity with bare .sort() on number arrays
 *                     'input-order': emit ready nodes in original ids order, cycle dump in ids order
 */
export function topoSort(
  ids: number[],
  getUpstream: (id: number) => number[],
  tieBreak: 'input-order' | 'string-asc',
): number[] {
  const emitted = new Set<number>()
  const result: number[] = []
  let remaining = [...ids]

  while (remaining.length > 0) {
    const ready = remaining.filter((id) => getUpstream(id).every((u) => emitted.has(u)))

    if (ready.length === 0) {
      // Cycle: dump remaining in tie-break order
      // legacy parity: bare .sort() sorts stringified ids (lexicographic, NOT numeric) — see #193 follow-up
      const dump = tieBreak === 'string-asc' ? [...remaining].sort() : [...remaining]
      result.push(...dump)
      break
    }

    const batch =
      tieBreak === 'string-asc'
        ? // legacy parity: bare .sort() sorts stringified ids (lexicographic, NOT numeric) — see #193 follow-up
          [...ready].sort()
        : ready // already in ids order — filter preserves remaining order, remaining preserves ids order

    for (const id of batch) {
      result.push(id)
      emitted.add(id)
    }
    const batchSet = new Set(batch)
    remaining = remaining.filter((id) => !batchSet.has(id))
  }

  return result
}
