export type PullRequestList = { numbers: number[]; incomplete: boolean; evidence: unknown }

export function parsePullRequestList(source: 'linked' | 'branch', raw: string): PullRequestList {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      numbers: [],
      incomplete: true,
      evidence: { source, status: 'invalid-json', error: error instanceof Error ? error.message : 'invalid-json' },
    }
  }
  if (!Array.isArray(parsed)) {
    return { numbers: [], incomplete: true, evidence: { source, status: 'non-array-response' } }
  }
  const numbers: number[] = []
  let invalid = parsed.length >= 1000
  for (const item of parsed) {
    if (
      item === null ||
      typeof item !== 'object' ||
      !('number' in item) ||
      typeof item.number !== 'number' ||
      !Number.isSafeInteger(item.number) ||
      item.number <= 0 ||
      !('state' in item) ||
      typeof item.state !== 'string' ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(item.state)
    ) {
      invalid = true
      continue
    }
    if (item.state !== 'MERGED') numbers.push(item.number)
  }
  return {
    numbers,
    incomplete: invalid,
    evidence: { source, status: invalid ? 'invalid-entries' : 'complete', numbers },
  }
}
