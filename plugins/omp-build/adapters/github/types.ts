import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { OperationRead } from '../../engine/history-schema.ts'
import type { Diagnostic, Json, Scope } from '../../engine/record-values.ts'
import type { ObservedComment } from '../../engine/review-schema.ts'

export type Gh = (cwd: string, args: string[]) => Promise<string>

export type GitHubOptions = {
  cwd: string
  /** Compatibility alias for the expected native actor. Prefer readAuthor/writeAuthor. */
  automationLogin?: string
  /** Native actor whose existing non-stop comments may form records during a read. */
  readAuthor?: string
  /** Native actor authorized only for observed stop records. */
  stopAuthor?: string
  /** Required native writer; normal records must match expectedAuthor. */
  writeAuthor?: string
  /** Explicit authenticated writer for installation tokens that cannot call `gh api user`. */
  writerLogin?: string
  /** Isolated-test seam. Production uses node:child_process execFile. */
  gh?: Gh
}

export class GitHubHistoryReadError extends Error {
  readonly diagnostics: Diagnostic[]

  constructor(message: string, diagnostics: Diagnostic[]) {
    super(message)
    this.name = 'GitHubHistoryReadError'
    this.diagnostics = diagnostics
  }
}

export type UnclaimedOperation = Omit<OperationRead, 'authority' | 'claimedKinds'> & {
  parsedKind?: string
}
export type ClaimedOperation = Omit<OperationRead, 'authority'>
export type Frame = {
  comment: ObservedComment
  version: string
  kind: string
  recordId: string
  operationId: string
  part: number
  total: number
  data: string
}
export type FrameFailure = {
  comment: ObservedComment
  operationId: string | null
  recordId: string | null
  kind: string | null
  diagnostic: Diagnostic
}
export type LooseHeaderClue = {
  comment: ObservedComment
  operationId: string | null
  recordId: string | null
  kind: string | null
}

const execFileAsync = promisify(execFile)
export const WIRE_PREFIX = '<!-- omp-build-record '
export const HEADER =
  /^<!-- omp-build-record v=(1) kind=([a-z][a-z0-9-]*) id=([^\s<>]+) operationId=([^\s<>]+) part=([1-9][0-9]*)\/([1-9][0-9]*) data=([A-Za-z0-9_-]+) -->\n[\s\S]*$/
export const RECORD_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
export const encoder = new TextEncoder()
export const decoder = new TextDecoder('utf-8', { fatal: true })

export function diagnostic(code: string, message: string, detail?: Json): Diagnostic {
  return detail === undefined ? { code, message } : { code, message, detail }
}

export function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

export function utf8Bytes(value: string): number {
  return utf8(value).byteLength
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

export function canonicalUtf8(value: string): boolean {
  try {
    return decoder.decode(utf8(value)) === value
  } catch {
    return false
  }
}

export function decodeHeaderIdentifier(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.length > 0 && encodeURIComponent(decoded) === value ? decoded : null
  } catch {
    return null
  }
}

export function defaultGh(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('gh', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).then(({ stdout }) => String(stdout).trim())
}

export function gh(options: GitHubOptions): Gh {
  return options.gh ?? defaultGh
}

export function targetNumber(scope: Scope): number {
  const separator = scope.target.lastIndexOf('#')
  const repository = separator > 0 ? scope.target.slice(0, separator) : ''
  const number = separator > 0 ? Number(scope.target.slice(separator + 1)) : Number.NaN
  if (
    !RECORD_REPOSITORY.test(scope.repository) ||
    repository !== scope.repository ||
    !Number.isSafeInteger(number) ||
    number < 1
  ) {
    throw new GitHubHistoryReadError('GitHub scope is invalid', [
      diagnostic('invalid-scope', `Scope ${scope.target} is not a GitHub repository issue target`),
    ])
  }
  return number
}

export function parseComment(value: unknown, scope: Scope, page: number, index: number): ObservedComment {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GitHubHistoryReadError('GitHub returned an invalid comment object', [
      diagnostic('invalid-github-response', 'Comment pagination returned a non-object'),
    ])
  }
  const entry = value as Record<string, unknown>
  const id = typeof entry.id === 'number' || typeof entry.id === 'string' ? String(entry.id) : null
  const user = entry.user
  const author =
    user !== null &&
    typeof user === 'object' &&
    !Array.isArray(user) &&
    typeof (user as Record<string, unknown>).login === 'string'
      ? ((user as Record<string, unknown>).login as string)
      : null
  return {
    locator: id === null ? `${scope.target}:page:${page}:index:${index}` : `${scope.target}:comment:${id}`,
    nativeId: id,
    body: typeof entry.body === 'string' ? entry.body : '',
    author,
    createdAt: typeof entry.created_at === 'string' ? entry.created_at : null,
    updatedAt: typeof entry.updated_at === 'string' ? entry.updated_at : null,
  }
}

export async function viewer(options: GitHubOptions): Promise<string> {
  const login = (await gh(options)(options.cwd, ['api', 'user', '--jq', '.login'])).trim()
  if (!login || /\s/.test(login)) {
    throw new GitHubHistoryReadError('GitHub did not return a native login', [
      diagnostic('missing-native-author', 'GitHub viewer login is absent or invalid'),
    ])
  }
  return login
}

export function expectedReadAuthor(options: GitHubOptions): Promise<string> {
  const configured = options.readAuthor ?? options.automationLogin
  return configured === undefined ? viewer(options) : Promise.resolve(configured)
}
