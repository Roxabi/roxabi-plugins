export function recordKind(body: string): string | null {
  const framed = /^<!-- omp-build-record v=1 kind=([a-z][a-z0-9-]*) /.exec(body)
  if (framed?.[1]) return framed[1]
  try {
    const parsed: unknown = JSON.parse(body)
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed) || typeof parsed.kind !== 'string') return null
    return parsed.kind
  } catch {
    return null
  }
}
