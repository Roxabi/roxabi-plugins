export async function safeAsync<T>(fn: () => Promise<T>, fallback: T, context: string): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    process.stderr.write(`[${context}] ${err instanceof Error ? err.message : String(err)}\n`)
    return fallback
  }
}
