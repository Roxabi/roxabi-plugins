import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_DEADLINE_MS = 25_000
const PROVIDER = 'openai-codex'
const MODEL = 'gpt-6.1-sol'
const THINKING = 'low'

const PROGRAMME_PATHS = [
  'plugins/omp-build/skills/dev-review/SKILL.md',
  'plugins/omp-build/skills/dev-review/root-causes.md',
  'plugins/omp-build/skills/dev-review/review-smells.md',
  'plugins/omp-build/skills/dev-review/review-classes.yml',
] as const

export interface Phase4Source {
  path: (typeof PROGRAMME_PATHS)[number]
  bytes: Uint8Array
  text: string
  /** Git object id of this file in commitSHA. */
  gitBlob: string
  /** SHA-256 of the bytes loaded from the candidate commit. */
  sourceSHA: string
}

export interface Phase4Programme {
  root: string
  commitSHA: string
  sources: Phase4Source[]
}

export interface Phase4Fixture {
  /** Stable fixture identifier included in provenance, not interpreted by the runner. */
  id: string
  /** Complete synthetic Phase 1–3 snapshot for the Phase 4 programme. */
  snapshot: string
}

export interface Phase4RunOptions {
  /** May shorten, never extend, the 25-second native and external bound. */
  deadlineMs?: number
  /** Per-call process environment, primarily for bounded subprocess transport tests. */
  env?: NodeJS.ProcessEnv
}

export interface Phase4SourceProvenance {
  path: string
  commitBlob: string
  commitSHA: string
  sourceSHA: string
  sentSHA: string
  /** False when a caller changed the loaded source before this invocation. */
  atCommit: boolean
}

export interface Phase4Run {
  body: string
  provenance: {
    programme: Phase4SourceProvenance[]
    fixture: { id: string; sha256: string }
    input: { sha256: string; deliveredSHA256: string }
    config: { sha256: string }
    limits: { externalDeadlineMs: number; nativeMaxTime: string }
    runtime: { path: string; realpath: string; version: string; provider: string; model: string; thinking: string }
  }
}

interface OwnedResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
}

interface NativeEvent {
  type?: unknown
  message?: unknown
  toolResults?: unknown
  isTerminal?: unknown
  yielded?: unknown
  messages?: unknown
  awaitingAsyncWork?: unknown
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function repositoryRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
}

function git(root: string, args: string[], encoding: 'buffer' | 'utf8' = 'utf8'): Buffer | string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding,
    env: gitEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0 || result.error) {
    throw new Error(`Phase 4 programme git probe failed: git ${args.join(' ')}`)
  }
  return result.stdout
}

/**
 * Reads the complete candidate programme from HEAD blobs, never from the worktree.
 * The source bytes and Git object ids remain paired with the commit that supplied them.
 */
export function readPhase4Programme(): Phase4Programme {
  const root = repositoryRoot()
  const commitSHA = (git(root, ['rev-parse', 'HEAD']) as string).trim()
  const sources = PROGRAMME_PATHS.map((path) => {
    const gitBlob = (git(root, ['rev-parse', `${commitSHA}:${path}`]) as string).trim()
    const bytes = new Uint8Array(git(root, ['show', `${commitSHA}:${path}`], 'buffer') as Buffer)
    return { path, bytes, text: Buffer.from(bytes).toString('utf8'), gitBlob, sourceSHA: sha256(bytes) }
  })
  return { root, commitSHA, sources }
}

function isolatedConfig(): string {
  // --no-tools requests a restricted tool set; stream validation rejects any invocation.
  // The overlay only uses documented retry controls and user context-file ids.
  return [
    'retry:',
    '  enabled: false',
    '  modelFallback: false',
    'disabledExtensions:',
    '  - context-file:user:AGENTS.md',
    '  - context-file:user:CLAUDE.md',
    '  - context-file:user:GEMINI.md',
    '  - context-file:user:copilot-instructions.md',
    '',
  ].join('\n')
}

function promptFor(programme: Phase4Programme, fixture: Phase4Fixture): string {
  const sources = programme.sources
    .map((source) => `<source path="${source.path}" git-blob="${source.gitBlob}">\n${source.text}\n</source>`)
    .join('\n\n')
  return [
    'Execute the supplied instruction programme, not this runner or fixture.',
    'This is a local, read-only Phase 4 qualification exercise, not a PR review or posting operation.',
    'Phases 1–3 are complete synthetic captured data below. Execute only Phase 4 collection, same-defect merge, classification, final test-gap rewrite, root-cause naming, grouping and local rendering.',
    'Do not perform Phase 8, invoke workers, use tools, read files, post a comment, invent a PR, a REVIEWED_HEAD, or additional findings about the programme or harness.',
    'Return only the one rendered review body required by the programme. Preserve all final findings, their evidence and provenance associations, groups, and one declared verdict.',
    '',
    '<actual-candidate-programme>',
    sources,
    '</actual-candidate-programme>',
    '',
    '<complete-synthetic-fixture>',
    fixture.snapshot,
    '</complete-synthetic-fixture>',
    '',
  ].join('\n')
}

function deadline(options: Phase4RunOptions): number {
  const value = options.deadlineMs ?? MAX_DEADLINE_MS
  if (!Number.isInteger(value) || value <= 0 || value > MAX_DEADLINE_MS) {
    throw new RangeError(`Phase 4 deadline must be a positive integer no greater than ${MAX_DEADLINE_MS}ms`)
  }
  return value
}

function executableFrom(pathValue: string | undefined): string {
  for (const directory of (pathValue ?? '').split(':')) {
    if (!directory) continue
    const candidate = join(directory, 'omp')
    if (existsSync(candidate)) return candidate
  }
  throw new Error("Phase 4 native OMP executable was not found on this call's PATH")
}

function eventText(message: unknown): string {
  if (typeof message !== 'object' || message === null || !('content' in message) || !Array.isArray(message.content)) {
    return ''
  }
  return message.content
    .flatMap((part) => {
      if (
        typeof part !== 'object' ||
        part === null ||
        !('type' in part) ||
        part.type !== 'text' ||
        !('text' in part) ||
        typeof part.text !== 'string'
      ) {
        return []
      }
      return [part.text]
    })
    .join('')
}

function messageRole(message: unknown): string | null {
  if (typeof message !== 'object' || message === null || !('role' in message) || typeof message.role !== 'string') {
    return null
  }
  return message.role
}
function messageHasToolBlock(message: unknown): boolean {
  if (typeof message !== 'object' || message === null || !('content' in message) || !Array.isArray(message.content)) {
    return false
  }
  return message.content.some(
    (part) =>
      typeof part === 'object' &&
      part !== null &&
      'type' in part &&
      typeof part.type === 'string' &&
      /tool/i.test(part.type),
  )
}

function parseStream(stdout: string, input: string): { body: string; delivered: string } {
  const lines = stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0 || lines.some((line) => line === ''))
    throw new Error('Phase 4 native stream was empty or non-line-delimited')

  const events: NativeEvent[] = lines.map((line, index) => {
    try {
      const event: NativeEvent = JSON.parse(line)
      if (typeof event !== 'object' || event === null || Array.isArray(event)) throw new Error('not an object')
      return event
    } catch {
      throw new Error(`Phase 4 native stream line ${index + 1} was not JSON`)
    }
  })

  const typeOf = (event: NativeEvent) => (typeof event.type === 'string' ? event.type : '')
  const streamShape = () => {
    const countsByType: Record<string, number> = {}
    for (const event of events) countsByType[typeOf(event)] = (countsByType[typeOf(event)] ?? 0) + 1
    const counts = Object.entries(countsByType)
      .map(([type, count]) => `${type.slice(0, 64)}=${count}`)
      .join(',')
    return `lastType=${typeOf(events.at(-1) ?? {}).slice(0, 64)}, counts=${counts}, stdoutSha256=${sha256(stdout)}`
  }

  const blocked = /(tool|retry|fallback|model(?:_|-)change|error|length|abort|transport|timeout)/i
  if (events.some((event) => blocked.test(typeOf(event)) || messageHasToolBlock(event.message))) {
    throw new Error('Phase 4 native stream contained a forbidden tool, retry, fallback, model-change, or failure event')
  }

  const userMessages = events.filter(
    (event) => typeOf(event) === 'message_end' && messageRole(event.message) === 'user',
  )
  const assistants = events.filter(
    (event) => typeOf(event) === 'message_end' && messageRole(event.message) === 'assistant',
  )
  const turns = events.filter((event) => typeOf(event) === 'turn_end')
  const turnStarts = events.filter((event) => typeOf(event) === 'turn_start')
  const terminal = events.filter((event) => typeOf(event) === 'agent_end')
  if (
    userMessages.length !== 1 ||
    assistants.length !== 1 ||
    turns.length !== 1 ||
    turnStarts.length !== 1 ||
    terminal.length !== 1
  ) {
    throw new Error(
      `Phase 4 native stream did not contain exactly one complete user turn and terminal assistant response (${streamShape()})`,
    )
  }

  const delivered = eventText(userMessages[0].message)
  if (!delivered.includes(input)) throw new Error('Phase 4 native stream did not expose the complete delivered input')

  const assistant = assistants[0].message
  if (
    typeof assistant !== 'object' ||
    assistant === null ||
    !('provider' in assistant) ||
    !('model' in assistant) ||
    !('stopReason' in assistant) ||
    assistant.provider !== PROVIDER ||
    assistant.model !== MODEL ||
    assistant.stopReason !== 'stop'
  ) {
    throw new Error('Phase 4 native stream ended with an unexpected provider, model, or stop reason')
  }
  const turn = turns[0]
  if (Array.isArray(turn.toolResults) && turn.toolResults.length !== 0) {
    throw new Error('Phase 4 native stream executed a tool')
  }
  const end = terminal[0]
  const optionalFlags = [
    ['isTerminal', end.isTerminal],
    ['yielded', end.yielded],
    ['awaitingAsyncWork', end.awaitingAsyncWork],
  ] as const
  const malformed = optionalFlags.some(([, value]) => value !== undefined && typeof value !== 'boolean')
  const incompatible = end.isTerminal === false || end.yielded === false || end.awaitingAsyncWork === true
  if (malformed || incompatible) {
    const flags = optionalFlags
      .map(
        ([name, value]) =>
          `${name}=${value === undefined ? 'absent' : typeof value === 'boolean' ? value : 'malformed'}`,
      )
      .join(',')
    throw new Error(`Phase 4 native terminal refused (flags=${flags}, ${streamShape()})`)
  }

  const body = eventText(assistant)
  if (!body) throw new Error('Phase 4 native stream omitted the rendered assistant body')
  return { body, delivered }
}

function safeFailureText(value: string): string {
  return value
    .replace(/((?:api[_-]?key|token|authorization|password|bearer)\s*(?::|=|\s)\s*)\S+/gi, '$1[redacted]')
    .trim()
    .slice(-500)
}

function failureDiagnostic(stage: string, result: OwnedResult): string {
  const status = result.code === null ? 'none' : String(result.code)
  const signal = result.signal ?? 'none'
  const stderr = safeFailureText(result.stderr)
  const stdout = safeFailureText(result.stdout)
  return `${stage} failed (exit=${status}, signal=${signal}, timedOut=${result.timedOut}, stdoutSha256=${sha256(result.stdout)}${stdout ? `, stdout=${stdout}` : ''}${stderr ? `, stderr=${stderr}` : ''})`
}

async function runOwned(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; deadlineMs: number },
): Promise<OwnedResult> {
  const { promise, reject, resolve: resolveResult } = Promise.withResolvers<OwnedResult>()
  let timedOut = false
  let cleanupStarted = false
  let cleanupFinished = false
  let closed: OwnedResult | undefined
  let transportError: Error | undefined
  let timer: NodeJS.Timeout | undefined
  let cleanupTimer: NodeJS.Timeout | undefined
  let cleanupError: Error | undefined
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

  const terminate = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return
      cleanupError = error instanceof Error ? error : new Error('Phase 4 process-group cleanup failed')
    }
  }
  const settle = () => {
    if (!cleanupFinished || (!closed && !transportError)) return
    clearTimeout(timer)
    clearTimeout(cleanupTimer)
    if (cleanupError) reject(cleanupError)
    else if (transportError) reject(transportError)
    else if (closed) resolveResult(closed)
  }
  const beginCleanup = () => {
    if (cleanupStarted) return
    cleanupStarted = true
    terminate('SIGTERM')
    cleanupTimer = setTimeout(() => {
      terminate('SIGKILL')
      cleanupFinished = true
      settle()
    }, 100)
  }
  timer = setTimeout(() => {
    timedOut = true
    beginCleanup()
  }, options.deadlineMs)
  child.once('error', (error) => {
    transportError = error
    beginCleanup()
  })
  child.once('exit', () => beginCleanup())
  child.once('close', (code, signal) => {
    closed = {
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
    }
    beginCleanup()
    settle()
  })
  child.stdin.end(options.input)
  return await promise
}

/** Runs one isolated native OMP invocation; it never retries, votes, or falls back. */
export async function runPhase4Model(
  programme: Phase4Programme,
  fixture: Phase4Fixture,
  options: Phase4RunOptions = {},
): Promise<Phase4Run> {
  if (process.platform === 'win32') {
    throw new Error('Phase 4 native OMP requires POSIX process-group cleanup')
  }
  const deadlineMs = deadline(options)
  const environment = { ...process.env, ...options.env }
  const executable = executableFrom(environment.PATH)
  const executableRealpath = realpathSync(executable)
  const config = isolatedConfig()
  const input = promptFor(programme, fixture)
  const sourceProvenance = programme.sources.map((source) => {
    const sentSHA = sha256(source.text)
    return {
      path: source.path,
      commitBlob: source.gitBlob,
      commitSHA: programme.commitSHA,
      sourceSHA: source.sourceSHA,
      sentSHA,
      atCommit: source.sourceSHA === sentSHA,
    }
  })
  const directory = mkdtempSync(join(tmpdir(), 'phase4-model-'))
  const configPath = join(directory, 'config.yml')
  const inputPath = join(directory, 'input.md')
  try {
    const version = await runOwned(executableRealpath, ['--version'], {
      cwd: directory,
      env: environment,
      deadlineMs: Math.min(deadlineMs, 2_000),
    })
    if (version.timedOut || version.code !== 0 || version.signal !== null) {
      throw new Error(failureDiagnostic('Phase 4 native OMP version probe', version))
    }
    writeFileSync(configPath, config)
    writeFileSync(inputPath, input)
    const nativeMaxTime = deadlineMs % 1000 === 0 ? `${deadlineMs / 1000}s` : `${deadlineMs}ms`
    const result = await runOwned(
      executableRealpath,
      [
        '--config',
        configPath,
        '--cwd',
        directory,
        '--provider',
        PROVIDER,
        '--model',
        MODEL,
        '--thinking',
        THINKING,
        '--no-tools',
        '--no-lsp',
        '--no-extensions',
        '--no-skills',
        '--no-rules',
        '--no-session',
        '--no-title',
        '--max-time',
        nativeMaxTime,
        '--mode',
        'json',
        '--print',
        `@${inputPath}`,
      ],
      { cwd: directory, env: environment, deadlineMs },
    )
    if (result.timedOut || result.code !== 0 || result.signal !== null) {
      throw new Error(failureDiagnostic('Phase 4 native OMP invocation', result))
    }
    const parsed = parseStream(result.stdout, input)
    return {
      body: parsed.body,
      provenance: {
        programme: sourceProvenance,
        fixture: { id: fixture.id, sha256: sha256(fixture.snapshot) },
        input: { sha256: sha256(input), deliveredSHA256: sha256(parsed.delivered) },
        config: { sha256: sha256(config) },
        limits: { externalDeadlineMs: deadlineMs, nativeMaxTime },
        runtime: {
          path: executable,
          realpath: executableRealpath,
          version: version.stdout.trim(),
          provider: PROVIDER,
          model: MODEL,
          thinking: THINKING,
        },
      },
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
