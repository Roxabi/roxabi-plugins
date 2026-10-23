import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  parseRecord,
  projectRecord,
  type RecordProjectionConfig,
  type Result,
  stopBotMayAuthor,
  WORKFLOW_RECORD_KINDS,
} from '../engine/core.ts'
import type {
  CanonicalRecord,
  DecodedHistory,
  Diagnostic,
  History,
  Json,
  ObservedComment,
  OperationAuthority,
  OperationRead,
  Scope,
} from '../engine/schemas.ts'

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

type Frame = {
  comment: ObservedComment
  version: string
  kind: string
  recordId: string
  operationId: string
  part: number
  total: number
  data: string
}

type FrameFailure = {
  comment: ObservedComment
  operationId: string | null
  recordId: string | null
  kind: string | null
  diagnostic: Diagnostic
}

type UnclaimedOperation = Omit<OperationRead, 'authority' | 'claimedKinds'> & { parsedKind?: string }

type ClaimedOperation = Omit<OperationRead, 'authority'>

const execFileAsync = promisify(execFile)
const WIRE_PREFIX = '<!-- omp-build-record '
const HEADER =
  /^<!-- omp-build-record v=(1) kind=([a-z][a-z0-9-]*) id=([^\s<>]+) operationId=([^\s<>]+) part=([1-9][0-9]*)\/([1-9][0-9]*) data=([A-Za-z0-9_-]+) -->\n[\s\S]*$/
const RECORD_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function diagnostic(code: string, message: string, detail?: Json): Diagnostic {
  return detail === undefined ? { code, message } : { code, message, detail }
}

function failure<T>(diagnostics: Diagnostic[]): Result<T> {
  return { ok: false, diagnostics }
}

function utf8(value: string): Uint8Array {
  return encoder.encode(value)
}

function utf8Bytes(value: string): number {
  return utf8(value).byteLength
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

function canonicalUtf8(value: string): boolean {
  try {
    return decoder.decode(utf8(value)) === value
  } catch {
    return false
  }
}

function decodeHeaderIdentifier(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value)
    return decoded.length > 0 && encodeURIComponent(decoded) === value ? decoded : null
  } catch {
    return null
  }
}

const KNOWN_KINDS: Record<string, true> = {
  'review-attempt': true,
  contribution: true,
  decision: true,
  review: true,
  'fix-request': true,
  'fix-result': true,
  'correction-result': true,
  'falsification-result': true,
  'debt-receipt': true,
  proof: true,
  stop: true,
  'epic-event': true,
  ...Object.fromEntries(WORKFLOW_RECORD_KINDS.map((kind) => [kind, true as const])),
}

const ACCOUNTED_KINDS: Record<string, true> = {
  proof: true,
  'epic-event': true,
  'correction-result': true,
  'falsification-result': true,
  'debt-receipt': true,
  'fix-result': true,
  ...Object.fromEntries(WORKFLOW_RECORD_KINDS.map((kind) => [kind, true as const])),
}

function defaultGh(cwd: string, args: string[]): Promise<string> {
  return execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) =>
    String(stdout).trim(),
  )
}

function gh(options: GitHubOptions): Gh {
  return options.gh ?? defaultGh
}

function targetNumber(scope: Scope): number {
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

/** Construct the opaque core scope used for either an issue or a pull request. */
export function githubScope(repository: string, number: number): Scope {
  if (!RECORD_REPOSITORY.test(repository) || !Number.isSafeInteger(number) || number < 1)
    throw new RangeError('GitHub scope requires owner/repository and a positive issue number')
  return { repository, target: `${repository}#${number}` }
}

async function viewer(options: GitHubOptions): Promise<string> {
  const login = (await gh(options)(options.cwd, ['api', 'user', '--jq', '.login'])).trim()
  if (!login || /\s/.test(login))
    throw new GitHubHistoryReadError('GitHub did not return a native login', [
      diagnostic('missing-native-author', 'GitHub viewer login is absent or invalid'),
    ])
  return login
}

function expectedReadAuthor(options: GitHubOptions): Promise<string> {
  const configured = options.readAuthor ?? options.automationLogin
  return configured === undefined ? viewer(options) : Promise.resolve(configured)
}

function parseComment(value: unknown, scope: Scope, page: number, index: number): ObservedComment {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new GitHubHistoryReadError('GitHub returned an invalid comment object', [
      diagnostic('invalid-github-response', 'Comment pagination returned a non-object'),
    ])
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

async function readWithAuthor(
  scope: Scope,
  options: GitHubOptions,
  expectedAuthor: string,
  stopAuthor: string | null,
): Promise<History> {
  const number = targetNumber(scope)
  if (!expectedAuthor || /\s/.test(expectedAuthor))
    throw new GitHubHistoryReadError('GitHub expected author is invalid', [
      diagnostic('missing-native-author', 'Expected GitHub author is absent or invalid'),
    ])
  if (stopAuthor !== null && (!stopAuthor || /\s/.test(stopAuthor)))
    throw new GitHubHistoryReadError('GitHub stop author is invalid', [
      diagnostic('missing-native-author', 'Stop GitHub author is absent or invalid'),
    ])
  const comments: ObservedComment[] = []
  try {
    for (let page = 1; ; page += 1) {
      const output = await gh(options)(options.cwd, [
        'api',
        `repos/${scope.repository}/issues/${number}/comments?per_page=100&page=${page}`,
      ])
      let parsed: unknown
      try {
        parsed = JSON.parse(output)
      } catch {
        throw new GitHubHistoryReadError('GitHub comment page is not JSON', [
          diagnostic('invalid-github-response', `Comment page ${page} is not valid JSON`),
        ])
      }
      if (!Array.isArray(parsed))
        throw new GitHubHistoryReadError('GitHub comment page is not an array', [
          diagnostic('invalid-github-response', `Comment page ${page} is not an array`),
        ])
      comments.push(...parsed.map((entry, index) => parseComment(entry, scope, page, index)))
      if (parsed.length < 100) break
    }
  } catch (error) {
    if (error instanceof GitHubHistoryReadError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new GitHubHistoryReadError('GitHub comments could not be read', [diagnostic('github-read-failed', message)])
  }
  return { scope, expectedAuthor, stopAuthor, complete: true, comments, diagnostics: [] }
}

/** Read every issue/PR comment and retain native identity and revision metadata. */
export async function readGitHubHistory(scope: Scope, options: GitHubOptions): Promise<History> {
  return readWithAuthor(scope, options, await expectedReadAuthor(options), options.stopAuthor ?? null)
}

type LooseHeaderClue = {
  comment: ObservedComment
  operationId: string | null
  recordId: string | null
  kind: string | null
}

function looseHeaderClue(comment: ObservedComment): LooseHeaderClue {
  const newline = comment.body.indexOf('\n')
  const header = comment.body.slice(0, newline === -1 ? comment.body.length : newline)
  const headerValue = (field: string): string | null => {
    const value = new RegExp(`\\b${field}=([^\\s<>]+)`).exec(header)?.[1]
    return value === undefined ? null : (decodeHeaderIdentifier(value) ?? value)
  }
  return {
    comment,
    operationId: headerValue('operationId'),
    recordId: headerValue('id'),
    kind: headerValue('kind'),
  }
}

function withClaimedKinds(operation: UnclaimedOperation): ClaimedOperation {
  const { parsedKind, ...read } = operation
  const claimedKinds: string[] = []
  const claim = (kind: string | null | undefined) => {
    if (kind !== null && kind !== undefined && !claimedKinds.includes(kind)) claimedKinds.push(kind)
  }
  for (const part of read.parts) claim(looseHeaderClue(part).kind)
  claim(read.kind)
  claim(parsedKind)
  claim(read.record?.kind)
  return { ...read, claimedKinds: claimedKinds.sort() }
}

function frameFrom(comment: ObservedComment): Frame | FrameFailure | null {
  if (!comment.body.startsWith(WIRE_PREFIX)) return null
  const match = HEADER.exec(comment.body)
  if (match === null) {
    const clue = looseHeaderClue(comment)
    return {
      comment,
      operationId: clue.operationId,
      recordId: clue.recordId,
      kind: clue.kind,
      diagnostic: diagnostic('invalid-framing', `Comment ${comment.locator} has a malformed canonical record header`),
    }
  }
  const [, version, kind, recordIdText, operationIdText, partText, totalText, data] = match
  const recordId = decodeHeaderIdentifier(recordIdText)
  const operationId = decodeHeaderIdentifier(operationIdText)
  if (recordId === null || operationId === null) {
    return {
      comment,
      operationId,
      recordId,
      kind,
      diagnostic: diagnostic('invalid-framing', `Comment ${comment.locator} has non-canonical record identifiers`),
    }
  }
  const part = Number(partText)
  const total = Number(totalText)
  if (part > total || !Number.isSafeInteger(part) || !Number.isSafeInteger(total))
    return {
      comment,
      operationId,
      recordId,
      kind,
      diagnostic: diagnostic('invalid-framing', `Comment ${comment.locator} has an invalid part range`),
    }
  return { comment, version, kind, recordId, operationId, part, total, data }
}

function legacyKind(body: string): string | null {
  const marker = /^<!-- omp-build:([a-z][a-z0-9-]*)\b/.exec(body)
  if (marker === null || body.startsWith(WIRE_PREFIX)) return null
  return marker[1] === 'review' || marker[1] === 'final-review' ? 'review' : marker[1]
}

function withOperationId(diagnostics: Diagnostic[], operationId: string | null): Diagnostic[] {
  return operationId === null ? diagnostics : diagnostics.map((entry) => ({ ...entry, operationId }))
}

function operationAuthority(
  operation: ClaimedOperation,
  history: History,
  clues: LooseHeaderClue[],
): OperationAuthority {
  const kind = operation.record?.kind ?? operation.kind
  const ownParts = new Set(operation.parts.map((part) => part.locator))
  const authors = new Set(operation.parts.map((part) => part.author))
  const nativeComplete = operation.parts.every((part) => part.nativeId !== null)
  const partClues = operation.parts.map(looseHeaderClue)
  const partKinds = new Set(partClues.map((clue) => clue.kind).filter((value): value is string => value !== null))
  const partRecordIds = new Set(
    partClues.map((clue) => clue.recordId).filter((value): value is string => value !== null),
  )
  const metadataCollision =
    partKinds.size > 1 ||
    partRecordIds.size > 1 ||
    (kind !== null && partKinds.size === 1 && !partKinds.has(kind)) ||
    (operation.recordId !== null && partRecordIds.size === 1 && !partRecordIds.has(operation.recordId))
  const collision = clues.some(
    (clue) =>
      !ownParts.has(clue.comment.locator) &&
      ((operation.operationId !== null && clue.operationId === operation.operationId) ||
        (operation.recordId !== null && clue.recordId === operation.recordId)),
  )
  if (
    kind === null ||
    KNOWN_KINDS[kind] === undefined ||
    authors.size !== 1 ||
    authors.has(null) ||
    !nativeComplete ||
    metadataCollision ||
    collision
  )
    return 'authority'
  const [author] = authors
  if (author === undefined) return 'authority'
  const trusted =
    author === history.expectedAuthor || (author === history.stopAuthor && stopBotMayAuthor(operation.claimedKinds))
  if (!trusted) return 'foreign'
  if (operation.claimedKinds.some((claim) => claim !== kind)) return 'authority'
  const completeCorrection =
    operation.status === 'complete' &&
    operation.record !== null &&
    (operation.record.kind === 'fix-request' ||
      (operation.record.kind === 'review-attempt' && operation.record.payload.purpose === 'correction'))
  if (completeCorrection) return 'accounted'
  if (kind === 'review' || kind === 'stop') return 'authority'
  return ACCOUNTED_KINDS[kind] === true ? 'accounted' : 'authority'
}

function decodeParts(
  scope: Scope,
  expectedAuthor: string,
  stopAuthor: string | null,
  operationId: string,
  frames: Frame[],
): { operation: UnclaimedOperation; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const parts = [...frames].sort((left, right) => left.part - right.part).map((frame) => frame.comment)
  const first = frames[0]
  if (first === undefined) throw new Error('decodeParts requires a frame')
  const metadataMatches = frames.every(
    (frame) =>
      frame.version === first.version &&
      frame.kind === first.kind &&
      frame.recordId === first.recordId &&
      frame.total === first.total,
  )
  if (!metadataMatches)
    return {
      operation: { operationId, recordId: first.recordId, kind: first.kind, status: 'conflict', parts, record: null },
      diagnostics: [diagnostic('conflicting-duplicate', `Operation ${operationId} repeats conflicting metadata`)],
    }
  const nativeAuthor = first.comment.author
  const nativeConsistent =
    nativeAuthor !== null &&
    frames.every((frame) => frame.comment.nativeId !== null && frame.comment.author === nativeAuthor)
  const byPart = new Map<number, Frame>()
  for (const frame of frames) {
    const existing = byPart.get(frame.part)
    if (existing !== undefined && (existing.data !== frame.data || existing.comment.body !== frame.comment.body)) {
      return {
        operation: { operationId, recordId: first.recordId, kind: first.kind, status: 'conflict', parts, record: null },
        diagnostics: [
          diagnostic('conflicting-duplicate', `Operation ${operationId} has conflicting part ${frame.part}`),
        ],
      }
    }
    byPart.set(frame.part, frame)
  }
  if (
    byPart.size !== first.total ||
    [...byPart.keys()].some((part) => part < 1 || part > first.total || !byPart.has(part))
  ) {
    return {
      operation: { operationId, recordId: first.recordId, kind: first.kind, status: 'incomplete', parts, record: null },
      diagnostics: [diagnostic('incomplete', `Operation ${operationId} is missing required publication parts`)],
    }
  }
  const encoded = [...byPart.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, frame]) => frame.data)
    .join('')
  let text: string
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('non-canonical base64url')
    const bytes = Buffer.from(encoded, 'base64url')
    if (base64url(bytes) !== encoded) throw new Error('non-canonical base64url')
    text = decoder.decode(bytes)
  } catch {
    return {
      operation: { operationId, recordId: first.recordId, kind: first.kind, status: 'invalid', parts, record: null },
      diagnostics: [diagnostic('invalid-encoding', `Operation ${operationId} has non-canonical UTF-8/base64url data`)],
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return {
      operation: { operationId, recordId: first.recordId, kind: first.kind, status: 'invalid', parts, record: null },
      diagnostics: [diagnostic('invalid-json', `Operation ${operationId} data is not JSON`)],
    }
  }
  const parsed = parseRecord(raw)
  const headerAuthorized =
    nativeConsistent &&
    (nativeAuthor === expectedAuthor ||
      (nativeAuthor === stopAuthor && first.kind === 'stop' && frames.every((frame) => frame.kind === 'stop')))
  if (!parsed.ok) {
    if (!headerAuthorized) {
      return {
        operation: { operationId, recordId: first.recordId, kind: first.kind, status: 'invalid', parts, record: null },
        diagnostics: [
          diagnostic('native-author-mismatch', `Operation ${operationId} has a wrong or inconsistent native writer`),
        ],
      }
    }
    return {
      operation: { operationId, recordId: first.recordId, kind: first.kind, status: 'invalid', parts, record: null },
      diagnostics: parsed.diagnostics,
    }
  }
  if (JSON.stringify(parsed.value) !== text)
    return {
      operation: {
        operationId,
        recordId: first.recordId,
        kind: first.kind,
        status: 'invalid',
        parts,
        record: null,
        parsedKind: parsed.value.kind,
      },
      diagnostics: [diagnostic('non-canonical-json', `Operation ${operationId} data is not canonical JSON`)],
    }
  const nativeAuthorized =
    nativeAuthor === expectedAuthor ||
    (nativeAuthor === stopAuthor && parsed.value.kind === 'stop' && frames.every((frame) => frame.kind === 'stop'))
  if (!nativeConsistent || !nativeAuthorized)
    return {
      operation: {
        operationId,
        recordId: first.recordId,
        kind: first.kind,
        status: 'invalid',
        parts,
        record: null,
        parsedKind: parsed.value.kind,
      },
      diagnostics: [
        diagnostic('native-author-mismatch', `Operation ${operationId} has a wrong or inconsistent native writer`),
      ],
    }
  if (
    parsed.value.version !== 1 ||
    parsed.value.kind !== first.kind ||
    parsed.value.recordId !== first.recordId ||
    parsed.value.operationId !== operationId ||
    parsed.value.repository !== scope.repository ||
    parsed.value.target !== scope.target
  ) {
    return {
      operation: {
        operationId,
        recordId: first.recordId,
        kind: first.kind,
        status: 'invalid',
        parts,
        record: null,
        parsedKind: parsed.value.kind,
      },
      diagnostics: [
        diagnostic('header-metadata-mismatch', `Operation ${operationId} header metadata does not bind its record`),
      ],
    }
  }
  return {
    operation: {
      operationId,
      recordId: first.recordId,
      kind: first.kind,
      status: 'complete',
      parts,
      record: parsed.value,
    },
    diagnostics,
  }
}

/** Decode only the framed transport; human Markdown is intentionally never parsed. */
export function decodeHistory(history: History): DecodedHistory {
  const diagnostics: Diagnostic[] = []
  const framed = new Map<string, Frame[]>()
  const invalid = new Map<string, FrameFailure[]>()
  const legacy: UnclaimedOperation[] = []
  const clues = history.comments.filter((comment) => comment.body.startsWith(WIRE_PREFIX)).map(looseHeaderClue)
  for (const comment of history.comments) {
    const frame = frameFrom(comment)
    if (frame === null) {
      const kind = legacyKind(comment.body)
      if (kind !== null)
        legacy.push({ operationId: null, recordId: null, kind, status: 'legacy', parts: [comment], record: null })
      continue
    }
    if ('diagnostic' in frame) {
      const key =
        frame.operationId === null
          ? `invalid:${frame.comment.locator}`
          : `invalid:${JSON.stringify([frame.operationId, frame.recordId, frame.kind])}`
      const entries = invalid.get(key) ?? []
      entries.push(frame)
      invalid.set(key, entries)
      continue
    }
    const entries = framed.get(frame.operationId) ?? []
    entries.push(frame)
    framed.set(frame.operationId, entries)
  }
  const operations: UnclaimedOperation[] = []
  for (const [, failures] of invalid) {
    const firstFailure = failures[0]
    if (firstFailure === undefined) continue
    operations.push({
      operationId: firstFailure.operationId,
      recordId: firstFailure.recordId,
      kind: firstFailure.kind,
      status: 'invalid',
      parts: failures.map((failure) => failure.comment),
      record: null,
    })
    diagnostics.push(
      ...withOperationId(
        failures.map((failure) => failure.diagnostic),
        firstFailure.operationId,
      ),
    )
  }
  for (const [operationId, frames] of framed) {
    const decoded = decodeParts(history.scope, history.expectedAuthor, history.stopAuthor, operationId, frames)
    operations.push(decoded.operation)
    diagnostics.push(...withOperationId(decoded.diagnostics, operationId))
  }
  operations.push(...legacy)
  for (const operation of legacy)
    diagnostics.push(
      diagnostic(
        'legacy-format',
        `Legacy record marker at ${operation.parts[0]?.locator ?? 'unknown'} cannot be admitted`,
      ),
    )
  return {
    source: history,
    operations: operations.map((operation) => {
      const claimed = withClaimedKinds(operation)
      return { ...claimed, authority: operationAuthority(claimed, history, clues) }
    }),
    diagnostics,
  }
}

function header(record: CanonicalRecord, part: number, total: number, data: string): string {
  return `<!-- omp-build-record v=1 kind=${record.kind} id=${encodeURIComponent(record.recordId)} operationId=${encodeURIComponent(record.operationId)} part=${part}/${total} data=${data} -->`
}

function textPrefix(value: string, offset: number, byteLimit: number): { text: string; next: number } | null {
  if (byteLimit < 0) return null
  let bytes = 0
  let next = offset
  for (const character of value.slice(offset)) {
    const width = utf8Bytes(character)
    if (bytes + width > byteLimit) break
    bytes += width
    next += character.length
  }
  return { text: value.slice(offset, next), next }
}

function encodeParts(record: CanonicalRecord, projection: string, maxCommentBytes: number): Result<string[]> {
  if (!Number.isSafeInteger(maxCommentBytes) || maxCommentBytes < 1)
    return failure([diagnostic('invalid-limit', 'Comment byte limit must be a positive safe integer')])
  try {
    encodeURIComponent(record.recordId)
    encodeURIComponent(record.operationId)
  } catch {
    return failure([diagnostic('invalid-framing', 'Record and operation IDs must be valid Unicode identifiers')])
  }
  const serialized = JSON.stringify(record)
  if (!canonicalUtf8(serialized) || !canonicalUtf8(projection))
    return failure([diagnostic('invalid-encoding', 'Record projection is not canonical UTF-8')])
  const encoded = base64url(utf8(serialized))
  const maximumParts = encoded.length + utf8Bytes(projection) + 1
  for (let total = 1; total <= maximumParts; total += 1) {
    const parts: string[] = []
    let dataOffset = 0
    let projectionOffset = 0
    let valid = true
    for (let part = 1; part <= total; part += 1) {
      const remainingParts = total - part + 1
      const dataLength = Math.ceil((encoded.length - dataOffset) / remainingParts)
      const data = encoded.slice(dataOffset, dataOffset + dataLength)
      const frame = header(record, part, total, data)
      const text = textPrefix(projection, projectionOffset, maxCommentBytes - utf8Bytes(frame) - 1)
      if (text === null || utf8Bytes(frame) + 1 + utf8Bytes(text.text) > maxCommentBytes) {
        valid = false
        break
      }
      parts.push(`${frame}\n${text.text}`)
      dataOffset += data.length
      projectionOffset = text.next
    }
    if (valid && dataOffset === encoded.length && projectionOffset === projection.length)
      return { ok: true, value: parts }
  }
  return failure([
    diagnostic(
      'comment-too-large',
      'The record and complete human projection cannot fit the requested comment byte limit',
    ),
  ])
}

/** Frame the full canonical record and its core-owned projection into UTF-8-safe comments. */
export function encodeRecord(
  record: CanonicalRecord,
  history: History,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[] = [],
  maxCommentBytes = 65_536,
): Result<string[]> {
  const parsed = parseRecord(record)
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics }
  const projection = projectRecord(parsed.value, decodeHistory(history), config, externalHistories)
  return projection.ok ? encodeParts(parsed.value, projection.value, maxCommentBytes) : projection
}

function sameOperation(record: CanonicalRecord, operation: OperationRead): boolean {
  const parsed = parseRecord(record)
  return (
    parsed.ok &&
    operation.operationId === parsed.value.operationId &&
    operation.status === 'complete' &&
    operation.record !== null &&
    JSON.stringify(parsed.value) === JSON.stringify(operation.record)
  )
}

function publicationFailure(status: 'uncertain' | 'refused', history: DecodedHistory, diagnostics: Diagnostic[]) {
  return { status, history, diagnostics } as const
}

async function freshHistory(
  record: CanonicalRecord,
  options: GitHubOptions,
  expectedAuthor: string,
  stopAuthor: string | null,
): Promise<DecodedHistory> {
  return decodeHistory(await readWithAuthor(record, options, expectedAuthor, stopAuthor))
}

/**
 * Publish idempotently: a fresh native read decides existing parts, and every
 * successful write is accepted only after a complete native read-back.
 */
export async function publishGitHubRecord(
  record: CanonicalRecord,
  history: DecodedHistory,
  options: GitHubOptions,
  config: RecordProjectionConfig | null,
  externalHistories: readonly DecodedHistory[] = [],
): Promise<
  | { status: 'confirmed'; operation: OperationRead }
  | { status: 'uncertain' | 'refused'; history: DecodedHistory; diagnostics: Diagnostic[] }
> {
  let expectedAuthor: string
  let writer: string
  const stopAuthor = options.stopAuthor ?? null
  try {
    expectedAuthor = await expectedReadAuthor(options)
    writer = options.writerLogin ?? (await viewer(options))
  } catch (error) {
    const diagnostics =
      error instanceof GitHubHistoryReadError
        ? error.diagnostics
        : [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))]
    return publicationFailure('uncertain', history, diagnostics)
  }
  if (options.writeAuthor !== undefined && options.writeAuthor !== writer)
    return publicationFailure('refused', history, [
      diagnostic(
        'native-author-mismatch',
        `Authenticated GitHub writer ${writer} is not configured writer ${options.writeAuthor}`,
      ),
    ])
  const writerAuthorized = writer === expectedAuthor || (writer === stopAuthor && stopBotMayAuthor([record.kind]))
  if (!writerAuthorized)
    return publicationFailure('refused', history, [
      diagnostic('native-author-mismatch', `GitHub writer ${writer} is not authorized for ${record.kind}`),
    ])
  let current: DecodedHistory
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor)
  } catch (error) {
    const diagnostics =
      error instanceof GitHubHistoryReadError
        ? error.diagnostics
        : [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))]
    return publicationFailure('uncertain', history, diagnostics)
  }
  const sameId = current.operations.filter((operation) => operation.operationId === record.operationId)
  const confirmed = sameId.find((operation) => sameOperation(record, operation))
  const incomplete = sameId.filter((operation) => operation.status === 'incomplete')
  if (confirmed !== undefined && sameId.length === 1) return { status: 'confirmed', operation: confirmed }
  if (
    sameId.length !== incomplete.length ||
    incomplete.some((operation) => operation.recordId !== record.recordId || operation.kind !== record.kind)
  ) {
    return publicationFailure('refused', current, [
      diagnostic(
        'operation-conflict',
        `Operation ${record.operationId} is already present but does not match this record`,
      ),
    ])
  }
  const knownPartLocators = new Set(incomplete.flatMap((operation) => operation.parts.map((part) => part.locator)))
  const encodingHistory: History =
    knownPartLocators.size === 0
      ? current.source
      : {
          ...current.source,
          comments: current.source.comments.filter((comment) => !knownPartLocators.has(comment.locator)),
        }
  const encoded = encodeRecord(record, encodingHistory, config, externalHistories)
  if (!encoded.ok) return publicationFailure('refused', current, encoded.diagnostics)
  const expectedBodies = new Set(encoded.value)
  const retainedBodies = incomplete.flatMap((operation) => operation.parts.map((part) => part.body))
  if (retainedBodies.some((body) => !expectedBodies.has(body))) {
    return publicationFailure('refused', current, [
      diagnostic(
        'operation-conflict',
        `Operation ${record.operationId} has publication parts that differ from this record`,
      ),
    ])
  }
  const existingBodies = new Set(current.source.comments.map((comment) => comment.body))
  for (const body of encoded.value) {
    if (existingBodies.has(body)) continue
    let response: string
    try {
      response = await gh(options)(options.cwd, [
        'api',
        '--method',
        'POST',
        `repos/${record.repository}/issues/${targetNumber(record)}/comments`,
        '-f',
        `body=${body}`,
      ])
    } catch (error) {
      try {
        current = await freshHistory(record, options, expectedAuthor, stopAuthor)
      } catch (readError) {
        const diagnostics =
          readError instanceof GitHubHistoryReadError
            ? readError.diagnostics
            : [diagnostic('github-read-failed', readError instanceof Error ? readError.message : String(readError))]
        return publicationFailure('uncertain', current, diagnostics)
      }
      const afterFailure = current.operations.find((operation) => sameOperation(record, operation))
      if (afterFailure !== undefined) return { status: 'confirmed', operation: afterFailure }
      return publicationFailure('uncertain', current, [
        diagnostic('github-write-uncertain', error instanceof Error ? error.message : String(error)),
      ])
    }
    let posted: ObservedComment
    try {
      posted = parseComment(JSON.parse(response), record, 0, 0)
    } catch (error) {
      return publicationFailure('uncertain', current, [
        diagnostic('invalid-github-response', error instanceof Error ? error.message : String(error)),
      ])
    }
    if (posted.nativeId === null || posted.author !== writer) {
      try {
        current = await freshHistory(record, options, expectedAuthor, stopAuthor)
      } catch (readError) {
        const diagnostics =
          readError instanceof GitHubHistoryReadError
            ? readError.diagnostics
            : [diagnostic('github-read-failed', readError instanceof Error ? readError.message : String(readError))]
        return publicationFailure('uncertain', current, diagnostics)
      }
      return publicationFailure('uncertain', current, [
        diagnostic(
          'native-author-mismatch',
          `GitHub POST response writer ${posted.author ?? 'unknown'} is not ${writer}`,
        ),
      ])
    }
  }
  try {
    current = await freshHistory(record, options, expectedAuthor, stopAuthor)
  } catch (error) {
    const diagnostics =
      error instanceof GitHubHistoryReadError
        ? error.diagnostics
        : [diagnostic('github-read-failed', error instanceof Error ? error.message : String(error))]
    return publicationFailure('uncertain', history, diagnostics)
  }
  const readBack = current.operations.find((operation) => sameOperation(record, operation))
  return readBack === undefined
    ? publicationFailure('uncertain', current, [
        diagnostic(
          'publication-unconfirmed',
          `Operation ${record.operationId} was not completely confirmed by native read-back`,
        ),
      ])
    : { status: 'confirmed', operation: readBack }
}
