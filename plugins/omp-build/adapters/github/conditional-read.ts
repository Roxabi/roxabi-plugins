import { gunzipSync, gzipSync } from 'node:zlib'
import { type GitHubOptions, gh, viewerCredentialKey } from './types.ts'

type Retained = { etag: string; body: Uint8Array }
type Included = { status: number; etag: string | null; body: string }

const RETAINED_LIMIT_BYTES = 64 * 1024 * 1024
const retained = new Map<string, Retained>()
let retainedBytes = 0

/** `gh api --include` output: status line, header lines, blank line, body. */
function parseIncluded(output: string): Included | null {
  const status = /^HTTP\/\S+ (\d{3})\b/.exec(output)
  if (status === null) return null
  const blank = /\r?\n\r?\n/.exec(output)
  const head = blank === null ? output : output.slice(0, blank.index)
  return {
    status: Number(status[1]),
    etag: /^etag:[ \t]*(\S+)/im.exec(head)?.[1] ?? null,
    body: blank === null ? '' : output.slice(blank.index + blank[0].length),
  }
}

/** `gh` exits non-zero on 304; the status survives on the failed call's output or its error text. */
function notModified(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false
  const failed = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
  if (typeof failed.stdout === 'string' && parseIncluded(failed.stdout)?.status === 304) return true
  return [failed.stderr, failed.message].some((text) => typeof text === 'string' && /\bHTTP 304\b/.test(text))
}

function forget(key: string): void {
  const entry = retained.get(key)
  if (entry === undefined) return
  retained.delete(key)
  retainedBytes -= entry.body.byteLength
}

function retain(key: string, etag: string, body: string): void {
  forget(key)
  // An exact-size copy: the counted bytes are the bytes held, whatever buffer zlib allocated.
  const entry = { etag, body: new Uint8Array(gzipSync(body)) }
  if (entry.body.byteLength > RETAINED_LIMIT_BYTES) return
  retained.set(key, entry)
  retainedBytes += entry.body.byteLength
  for (const oldest of retained.keys()) {
    if (retainedBytes <= RETAINED_LIMIT_BYTES) break
    forget(oldest)
  }
}

/** The body GitHub just confirmed. Recency moves only while this is still the retained entry. */
function reuse(key: string, known: Retained): string {
  if (retained.get(key) === known) {
    retained.delete(key)
    retained.set(key, known)
  }
  return gunzipSync(known.body).toString('utf8')
}

/**
 * Read one GET endpoint, letting GitHub confirm an unchanged resource instead of sending it again.
 * A 304 answer is not charged to the primary rate limit, so a repeated closure read costs quota
 * only for what changed. The retained body is returned on that 304 alone: any other failure
 * propagates, and a transport that reports no validator retains nothing.
 */
export async function readRevalidated(options: GitHubOptions, endpoint: string): Promise<string> {
  const key = `${viewerCredentialKey()}\0${endpoint}`
  const known = retained.get(key)
  const args = ['api', endpoint, '--include']
  if (known !== undefined) args.push('--header', `If-None-Match: ${known.etag}`)
  let output: string
  try {
    output = await gh(options)(options.cwd, args)
  } catch (error) {
    if (known === undefined || !notModified(error)) throw error
    return reuse(key, known)
  }
  const response = parseIncluded(output)
  if (response === null) return output
  if (response.status === 304 && known !== undefined) return reuse(key, known)
  if (response.status === 200 && response.etag !== null) retain(key, response.etag, response.body)
  else forget(key)
  return response.body
}
