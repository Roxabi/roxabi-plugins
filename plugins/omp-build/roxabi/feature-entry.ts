import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Diagnostic, HostEffectAdmission, ScopedRecordRef } from '../engine/schemas'
import type {
  Json,
  NativeBatch,
  NativeBatchCallbacks,
  NativeBatchResult,
  NativeProofBashCall,
} from '../omp/review-runtime'
import { ticketOfSubject, titleType } from '../skills/feature/epic.ts'
import type { PreparedEpicReview } from './epic-range-review'
import type { GitRunner } from './workflow-config'

export type FeatureControl = 'select' | 'continue' | 'resume' | 'pause' | 'abandon' | 'new' | 'material-decision'
export type FeatureDecision = 'accept' | 'reject'
export type FeatureSessionReason = 'session-stop' | 'session-switch' | 'session-shutdown'

export type FeatureNativePort = {
  activate(batch: NativeBatch, callbacks: NativeBatchCallbacks): void
  inactive(): void
  stopOwned(batch: NativeBatch, reason: string): Promise<void>
  announce(batch: NativeBatch): Promise<void>
}
export type FeatureFixTerminal =
  | { status: 'complete'; recordId: string; kind: 'fix-result' }
  | { status: 'stopped'; diagnostics: string[] }

export type ContinueFeatureResult =
  | { kind: 'action'; followUp: NativeBatch; start: ScopedRecordRef }
  | { kind: 'watch'; command: string }
  | { kind: 'epic-final-review'; review: PreparedEpicReview }
  | { kind: 'review'; pr: number }
  | { kind: 'fix'; reference: string }
  | { kind: 'admitted-ci-correction'; reference: string; attributionRecordId: string; scope: string }
  | { kind: 'blocked'; reason: string; diagnostics?: readonly Diagnostic[] }
  | { kind: 'paused'; confirmed: boolean; reason: string }
  | { kind: 'abandoned'; confirmed: boolean }
  | { kind: 'terminal'; reason: string; diagnostics?: readonly Diagnostic[] }
  | { kind: 'session-cwd'; path: string; instruction: string }
  | { kind: 'operator-decision'; reason: string }

export type ContinueFeatureInput = {
  cwd: string
  reference: string
  control: FeatureControl
  decision?: FeatureDecision
  principal: boolean
  native: FeatureNativePort
}

export type FeatureWorkflow = {
  continueFeature(input: ContinueFeatureInput): Promise<ContinueFeatureResult>
  consumeWatchExit(input: {
    cwd: string
    pr: number
    code: number
    reference: string
    gh?: (cwd: string, args: string[]) => Promise<string>
    git?: GitRunner
  }): Promise<ContinueFeatureResult>
  publishFeatureNativeResult(input: {
    cwd: string
    result: NativeBatchResult
    start: ScopedRecordRef
    startHead?: string
  }): Promise<{ published: true } | { published: false; reason: string }>
  requestFeatureSessionPause(input: {
    cwd: string
    reason: FeatureSessionReason
    interrupt: () => Promise<void>
    reference?: string
  }): Promise<{ kind: 'paused'; confirmed: boolean; reason: string }>
}

export type ParsedFeatureCommand =
  | { ok: true; control: FeatureControl; reference: string; decision?: FeatureDecision }
  | { ok: true; control: 'init'; args: readonly string[] }
  | { ok: false; reason: string }

const CONTROL_BY_WORD: Record<string, FeatureControl> = {
  pause: 'pause',
  abandon: 'abandon',
  new: 'new',
  resume: 'resume',
  'material-decision': 'material-decision',
}

export function parseFeatureCommand(args: string): ParsedFeatureCommand {
  const trimmed = args.trim()
  if (trimmed === 'init' || trimmed.startsWith('init ') || trimmed.startsWith('init\t')) {
    const tokens = shellTokens(trimmed)
    if (tokens === null || tokens[0] !== 'init') return { ok: false, reason: 'feature-init-invalid' }
    return { ok: true, control: 'init', args: tokens.slice(1) }
  }
  const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0)
  if (tokens.length === 0) return { ok: false, reason: 'feature-reference-missing' }
  const head = tokens[0] ?? ''
  if (head === 'material-decision') {
    const reference = normalizeReference(tokens[1])
    const decision = tokens[2]
    if (reference === null || (decision !== 'accept' && decision !== 'reject') || tokens.length !== 3) {
      return { ok: false, reason: 'feature-material-decision-invalid' }
    }
    return { ok: true, control: 'material-decision', reference, decision }
  }
  const control = CONTROL_BY_WORD[head]
  if (control !== undefined && head !== 'material-decision') {
    const reference = normalizeReference(tokens[1])
    if (reference === null || tokens.length !== 2) return { ok: false, reason: 'feature-reference-missing' }
    return { ok: true, control, reference }
  }
  if (tokens.length !== 1) return { ok: true, control: 'select', reference: args.trim() }
  const reference = normalizeReference(head)
  if (reference === null) return { ok: false, reason: 'feature-reference-invalid' }
  return { ok: true, control: 'select', reference }
}

function normalizeReference(token: string | undefined): string | null {
  if (token === undefined || token.length === 0) return null
  const stripped = token.startsWith('#') ? token.slice(1) : token
  if (stripped.length === 0 || CONTROL_BY_WORD[stripped] !== undefined) return null
  return stripped
}

type InstalledWatchCommand = {
  args: string[]
  pr: number
}

const ownedWatches = new WeakMap<object, AbortController>()

/** Ephemeral only. Pause, abandon, and session end abort the owned watch; nothing is written to disk. */
export function abortOwnedFeatureWatch(key: object): void {
  const controller = ownedWatches.get(key)
  if (controller === undefined) return
  ownedWatches.delete(key)
  controller.abort()
}

function readQuotedToken(input: string, start: number): { value: string; end: number } | null {
  if (input[start] !== "'") return null
  let index = start + 1
  let value = ''
  while (index < input.length) {
    if (input.startsWith("'\\''", index)) {
      value += "'"
      index += 4
      continue
    }
    if (input[index] === "'") return { value, end: index + 1 }
    value += input[index]
    index += 1
  }
  return null
}

function shellTokens(input: string): string[] | null {
  const tokens: string[] = []
  let index = 0
  while (index < input.length) {
    while (input[index] === ' ') index += 1
    if (index >= input.length) break
    if (input[index] === "'") {
      const quoted = readQuotedToken(input, index)
      if (quoted === null) return null
      tokens.push(quoted.value)
      index = quoted.end
      continue
    }
    const next = input.indexOf(' ', index)
    const raw = next === -1 ? input.slice(index) : input.slice(index, next)
    if (raw.length === 0 || raw.includes("'")) return null
    tokens.push(raw)
    index = next === -1 ? input.length : next
  }
  return tokens
}

/** The coordinator's existing `landPr` command, not a reconstructed watcher. */
function parseInstalledWatchCommand(command: string): InstalledWatchCommand | null {
  const tokens = shellTokens(command)
  if (tokens === null || tokens[0] !== 'bash' || tokens.length < 7) return null
  const script = tokens[1]
  const prText = tokens[2]
  if (script === undefined || !script.startsWith('/') || !script.endsWith('/ci-watch.sh')) return null
  if (prText === undefined || !/^[1-9]\d*$/.test(prText)) return null
  if (tokens[3] !== '--merge-mode' || tokens[4] === undefined || tokens[4].length === 0) return null
  if (tokens[5] !== '--base' || tokens[6] === undefined || tokens[6].length === 0) return null
  if (tokens.length === 7) return { args: tokens.slice(1), pr: Number(prText) }
  if (tokens.length === 9 && tokens[7] === '--since' && tokens[8] !== undefined && tokens[8].length > 0) {
    return { args: tokens.slice(1), pr: Number(prText) }
  }
  return null
}

/**
 * Pre-selection assisted framing only (`needs-framing`).
 * Never used for `needs-scope`: that can follow an already-published mandate/checkout,
 * and this copy must not deny durable history or imply the same unchanged ref will pass.
 */
export function featureAssistedFramingMessage(): string {
  return 'Frame with skill://grilling until shared understanding, then publish or amend through skill://issue-triage. Do not start a checkout, mandate, or native batch until the operator runs /feature #N on an actionable issue.'
}

function isAssistedFraming(reason: string): boolean {
  return reason === 'needs-framing'
}

export function featureSessionCwdMessage(cwd: string, instruction: string): string {
  return `session-cwd ${cwd}\n${instruction}`
}

/** Operator lines from already-built Diagnostic fields — no payload dump, reason enum unchanged. */
function detailPathMessages(detail: Diagnostic['detail']): string[] {
  if (!Array.isArray(detail)) return []
  const lines: string[] = []
  for (const entry of detail) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const path = 'path' in entry && typeof entry.path === 'string' ? entry.path.trim() : ''
    const message = 'message' in entry && typeof entry.message === 'string' ? entry.message.trim() : ''
    if (path.length > 0 && message.length > 0) lines.push(`${path} ${message}`)
    else if (message.length > 0) lines.push(message)
    else if (path.length > 0) lines.push(path)
  }
  return lines
}

function featureStoppedWithDiagnostics(reason: string, diagnostics: readonly Diagnostic[] | undefined): string {
  const head = `feature-stopped: ${reason}`
  if (diagnostics === undefined || diagnostics.length === 0) return head
  const lines = [head]
  for (const item of diagnostics) {
    const message = item.message.trim()
    if (message.length > 0) lines.push(message)
    const path = item.path?.trim()
    if (path !== undefined && path.length > 0) lines.push(path)
    lines.push(...detailPathMessages(item.detail))
  }
  return lines.join('\n')
}

// RoxabiWorkflow owns workflow.ts. It is absent until that slice lands, so a static
// import would fail extension load for the remaining skill commands.
const WORKFLOW_SPECIFIER = new URL('../roxabi/workflow.ts', import.meta.url).href

export async function loadFeatureWorkflow(): Promise<FeatureWorkflow> {
  try {
    const module = (await import(WORKFLOW_SPECIFIER)) as Partial<FeatureWorkflow>
    if (
      typeof module.continueFeature !== 'function' ||
      typeof module.consumeWatchExit !== 'function' ||
      typeof module.publishFeatureNativeResult !== 'function' ||
      typeof module.requestFeatureSessionPause !== 'function'
    ) {
      throw new Error('feature-workflow-unavailable')
    }
    return module as FeatureWorkflow
  } catch (error) {
    if (error instanceof Error && error.message === 'feature-workflow-unavailable') throw error
    throw new Error('feature-workflow-unavailable')
  }
}

type OwnedFeature = {
  reference: string
  cwd: string
  pausable: boolean
}

const ownedFeatures = new WeakMap<object, OwnedFeature>()

export function rememberFeatureOwner(key: object, owned: OwnedFeature): void {
  ownedFeatures.set(key, owned)
}

function releaseFeatureOwner(key: object): void {
  ownedFeatures.delete(key)
}

export function featureOwner(key: object): OwnedFeature | undefined {
  return ownedFeatures.get(key)
}

export type FeatureCommandHost = {
  key: object
  cwd: string
  principal: boolean
  workflow: FeatureWorkflow
  native: FeatureNativePort
  send: (text: string) => Promise<void>
  inhibitFeatureContinuation: () => void
  releaseFeatureContinuation: () => void
  featureContinuationInhibited: () => boolean
  markFeatureBatch: (batch: NativeBatch) => void
  startReview?: (args: string, onComplete: () => Promise<void>) => Promise<void>
  startFix?: (reference: string) => Promise<{ terminal: Promise<FeatureFixTerminal> }>
  startAdmittedCiCorrection?: (input: {
    reference: string
    attributionRecordId: string
    scope: string
  }) => Promise<{ terminal: Promise<FeatureFixTerminal> }>
  prepareEpicRangeReview?: (review: PreparedEpicReview, onComplete: () => Promise<void>) => Promise<void>
  git?: FeatureGit
  interruptOwnedWork?: (reason: string) => Promise<void>
  exec: (
    command: string,
    args: string[],
    options?: { cwd?: string; signal?: AbortSignal },
  ) => Promise<{ code: number; killed: boolean; stdout?: string; stderr?: string }>
}

async function runTrustedFeatureInit(args: readonly string[], host: FeatureCommandHost): Promise<void> {
  const git = host.git ?? defaultFeatureGit
  const captured = await git(['rev-parse', '--show-toplevel'], host.cwd)
  const dir = captured.stdout.trim()
  if (captured.exitCode !== 0 || !dir.startsWith('/')) {
    await host.send('feature-stopped: feature-init-target-unobserved')
    return
  }
  let script: string
  try {
    script = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '../skills/feature/feature-init.ts'))
  } catch {
    await host.send('feature-stopped: feature-init-unresolved')
    return
  }
  const result = await host.exec('bun', ['--no-env-file', script, '--dir', dir, ...args], { cwd: dirname(script) })
  if (result.stdout !== undefined && result.stdout.length > 0) await host.send(result.stdout)
  if (result.code !== 0) {
    const detail = result.stderr?.trim()
    await host.send(detail ? `feature-stopped: feature-init-exit\n${detail}` : 'feature-stopped: feature-init-exit')
  }
}

export async function runInstalledFeatureCommand(args: string, host: FeatureCommandHost): Promise<void> {
  const parsed = parseFeatureCommand(args)
  if (!parsed.ok) {
    await host.send(`feature-stopped: ${parsed.reason}`)
    return
  }
  if (parsed.control === 'init') {
    await runTrustedFeatureInit(parsed.args, host)
    return
  }
  const stopsContinuation = parsed.control === 'pause' || parsed.control === 'abandon'
  if (stopsContinuation) {
    abortOwnedFeatureWatch(host.key)
    host.inhibitFeatureContinuation()
    await host.interruptOwnedWork?.(parsed.control)
  } else if (parsed.control === 'select' || parsed.control === 'resume') host.releaseFeatureContinuation()

  const principalDispatch =
    host.principal && (parsed.control === 'select' || parsed.control === 'resume' || parsed.control === 'new')
  const native = principalDispatch ? refusingFeaturePort() : host.native
  let result: ContinueFeatureResult
  try {
    result = await host.workflow.continueFeature({
      cwd: host.cwd,
      reference: parsed.reference,
      control: parsed.control,
      decision: parsed.decision,
      principal: host.principal,
      native,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (principalDispatch) {
      await host.send(`session-cwd ${host.cwd}\nfeature-stopped: principal-dispatch-refused`)
      return
    }
    await host.send(`feature-stopped: ${reason}`)
    return
  }
  if (principalDispatch) {
    await deliverPrincipalRefusal(host, result)
    return
  }
  await deliverFeatureResult(parsed.reference, result, host)
}

async function deliverPrincipalRefusal(host: FeatureCommandHost, result: ContinueFeatureResult): Promise<void> {
  if (result.kind === 'session-cwd' && result.path.startsWith('/') && result.instruction === `/move ${result.path}`) {
    await host.send(featureSessionCwdMessage(result.path, result.instruction))
    return
  }
  await host.send(`session-cwd ${host.cwd}\nfeature-stopped: principal-dispatch-refused`)
}

function settleInstalledWatch(
  reference: string,
  host: FeatureCommandHost,
  controller: AbortController,
  cwd: string,
  pr: number,
  pending: Promise<{ code: number; killed: boolean }>,
): void {
  void pending.then(
    async (result) => {
      if (ownedWatches.get(host.key) === controller) ownedWatches.delete(host.key)
      if (controller.signal.aborted) return
      if (result.killed || result.code < 0) {
        await host.send('feature-stopped: watch-exit-unobserved')
        return
      }
      if (host.featureContinuationInhibited()) {
        await host.send('feature-stopped: continuation-inhibited')
        return
      }
      try {
        const next = await host.workflow.consumeWatchExit({ cwd, pr, code: result.code, reference })
        await deliverFeatureResult(reference, next, host)
      } catch (error) {
        await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    async (error: unknown) => {
      if (ownedWatches.get(host.key) === controller) ownedWatches.delete(host.key)
      if (controller.signal.aborted) return
      await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

async function deliverFeatureResult(
  reference: string,
  result: ContinueFeatureResult,
  host: FeatureCommandHost,
): Promise<void> {
  switch (result.kind) {
    case 'session-cwd':
      if (!(result.path.startsWith('/') && result.instruction === `/move ${result.path}`)) {
        await host.send(`session-cwd ${host.cwd}\nfeature-stopped: move-instruction-invalid`)
        return
      }
      if (sameRealpath(result.path, host.cwd)) {
        await host.send('feature-stopped: session-cwd-already-current')
        return
      }
      await host.send(featureSessionCwdMessage(result.path, result.instruction))
      return
    case 'action':
      await announceFeatureBatch(reference, result.followUp, result.start, host)
      return
    case 'watch': {
      if (host.principal || host.featureContinuationInhibited()) {
        await host.send('feature-stopped: continuation-inhibited')
        return
      }
      const watch = parseInstalledWatchCommand(result.command)
      if (watch === null) {
        await host.send('feature-stopped: watch-command-invalid')
        return
      }
      abortOwnedFeatureWatch(host.key)
      const controller = new AbortController()
      ownedWatches.set(host.key, controller)
      rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: true })
      settleInstalledWatch(
        reference,
        host,
        controller,
        host.cwd,
        watch.pr,
        host.exec('bash', watch.args, { cwd: host.cwd, signal: controller.signal }),
      )
      // Idle Esc/RPC while only this host watch runs is not a workflow pause (D2-B).
      await host.send(
        'ci-watch: running. Idle Esc/RPC does not pause or disarm this watch — use /feature pause or /feature abandon; session switch/shutdown still pause.',
      )
      return
    }
    case 'paused':
      rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: false })
      await host.send(result.confirmed === true ? `pause-confirmed: ${result.reason}` : pauseUnconfirmed(result.reason))
      return
    case 'abandoned':
      if (result.confirmed !== true) {
        rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: false })
        await host.send('feature-stopped: abandon-unconfirmed')
        return
      }
      releaseFeatureOwner(host.key)
      await host.send('feature-abandoned')
      return
    case 'blocked':
      if (isAssistedFraming(result.reason)) {
        await host.send(featureAssistedFramingMessage())
        return
      }
      rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: false })
      await host.send(featureStoppedWithDiagnostics(result.reason, result.diagnostics))
      return
    case 'terminal':
      releaseFeatureOwner(host.key)
      await host.send(featureStoppedWithDiagnostics(result.reason, result.diagnostics))
      return
    case 'operator-decision':
      if (isAssistedFraming(result.reason)) {
        await host.send(featureAssistedFramingMessage())
        return
      }
      await host.send(`feature-stopped: operator-decision:${result.reason}`)
      return
    case 'review':
      if (host.startReview === undefined) {
        await host.send('feature-stopped: review-unavailable')
        return
      }
      rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: true })
      try {
        await host.startReview(String(result.pr), () => continueAfterReview(reference, host))
      } catch (error) {
        releaseFeatureOwner(host.key)
        throw error
      }
      return
    case 'fix':
      await continueAfterFix(reference, result.reference, host)
      return
    case 'admitted-ci-correction':
      await continueAfterAdmittedCiCorrection(reference, result, host)
      return
    case 'epic-final-review':
      await deliverEpicFinalReview(result, host)
      return
    default:
      await host.send('feature-stopped: feature-result-invalid')
  }
}

function pauseUnconfirmed(reason: string): string {
  const safe = reason.toLowerCase().includes('disarmed') ? 'pause-unconfirmed' : reason
  return `pause-unconfirmed: ${safe}`
}

async function announceFeatureBatch(
  reference: string,
  followUp: NativeBatch,
  actionStart: ScopedRecordRef,
  host: FeatureCommandHost,
): Promise<void> {
  if (!isNativeBatch(followUp)) {
    await host.send('feature-stopped: action-undeliverable')
    return
  }
  if (host.featureContinuationInhibited() || host.principal) {
    await host.send('feature-stopped: continuation-inhibited')
    return
  }
  host.markFeatureBatch(followUp)
  actionStarts.set(followUp, actionStart)
  if (isImplementationBatch(followUp)) {
    const start = await readImplementationStart(host)
    if (!start.ok) {
      await host.send(`feature-stopped: ${start.reason}`)
      return
    }
    implementationStarts.set(followUp, start.head)
  }
  const callbacks: NativeBatchCallbacks = {
    onComplete: async (settled) => {
      try {
        const start = actionStarts.get(settled.batch)
        if (start === undefined) throw new Error('action-start-missing')
        const startHead = implementationStarts.get(settled.batch)
        const published = await host.workflow.publishFeatureNativeResult({
          cwd: host.cwd,
          result: settled,
          start,
          ...(startHead === undefined ? {} : { startHead }),
        })
        if (published.published !== true) throw new Error(published.reason)
      } catch (error) {
        await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
        throw error
      }
    },
    onSettled: async () => {
      if (host.featureContinuationInhibited()) return
      const next = await host.workflow.continueFeature({
        cwd: host.cwd,
        reference,
        control: 'continue',
        principal: false,
        native: host.native,
      })
      await deliverFeatureResult(reference, next, host)
    },
    onStop: async () => {
      rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: true })
    },
  }
  try {
    host.native.activate(followUp, callbacks)
    await host.native.announce(followUp)
  } catch (error) {
    host.native.inactive()
    await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  rememberFeatureOwner(host.key, { reference, cwd: host.cwd, pausable: true })
}

async function continueAfterReview(reference: string, host: FeatureCommandHost): Promise<void> {
  if (host.featureContinuationInhibited()) return
  const next = await host.workflow.continueFeature({
    cwd: host.cwd,
    reference,
    control: 'continue',
    principal: false,
    native: host.native,
  })
  await deliverFeatureResult(reference, next, host)
}

function observeFeatureTerminal(
  reference: string,
  host: FeatureCommandHost,
  terminal: Promise<FeatureFixTerminal>,
): void {
  void terminal
    .then(async (result) => {
      if (result.status !== 'complete' || host.featureContinuationInhibited()) return
      const next = await host.workflow.continueFeature({
        cwd: host.cwd,
        reference,
        control: 'continue',
        principal: false,
        native: host.native,
      })
      await deliverFeatureResult(reference, next, host)
    })
    .catch(async (error: unknown) => {
      await host.send(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
    })
}

async function continueAfterFix(reference: string, fixReference: string, host: FeatureCommandHost): Promise<void> {
  if (host.startFix === undefined) {
    await host.send('feature-stopped: fix-unavailable')
    return
  }
  const run = await host.startFix(fixReference)
  observeFeatureTerminal(reference, host, run.terminal)
}

async function continueAfterAdmittedCiCorrection(
  reference: string,
  result: Extract<ContinueFeatureResult, { kind: 'admitted-ci-correction' }>,
  host: FeatureCommandHost,
): Promise<void> {
  if (host.startAdmittedCiCorrection === undefined) {
    await host.send('feature-stopped: ci-correction-unavailable')
    return
  }
  const run = await host.startAdmittedCiCorrection({
    reference: result.reference,
    attributionRecordId: result.attributionRecordId,
    scope: result.scope,
  })
  observeFeatureTerminal(reference, host, run.terminal)
}

async function deliverEpicFinalReview(
  result: Extract<ContinueFeatureResult, { kind: 'epic-final-review' }>,
  host: FeatureCommandHost,
): Promise<void> {
  if (host.prepareEpicRangeReview === undefined) {
    await host.send('feature-stopped: epic-final-review-unprepared')
    return
  }
  const target = `#${result.review.context.number}`
  rememberFeatureOwner(host.key, { reference: target, cwd: host.cwd, pausable: true })
  try {
    await host.prepareEpicRangeReview(result.review, () => continueAfterReview(target, host))
  } catch (error) {
    releaseFeatureOwner(host.key)
    await host.send(`feature-stopped: ${error instanceof Error ? error.message : 'epic-final-review-unprepared'}`)
  }
}

function isNativeBatch(value: NativeBatch): boolean {
  return (
    typeof value?.operationId === 'string' &&
    value.operationId.length > 0 &&
    Array.isArray(value.tasks?.tasks) &&
    value.tasks.tasks.length > 0 &&
    value.tasks.tasks.every(
      (task) => typeof task.name === 'string' && task.name.length > 0 && typeof task.agent === 'string',
    )
  )
}

function refusingFeaturePort(): FeatureNativePort {
  return {
    activate() {
      throw new Error('principal-dispatch-refused')
    },
    inactive() {},
    async stopOwned() {},
    async announce() {
      throw new Error('principal-dispatch-refused')
    },
  }
}

export async function pauseOwnedFeatureOnSessionEnd(
  key: object,
  reason: FeatureSessionReason,
  workflow: FeatureWorkflow,
  interrupt: () => Promise<void>,
  report?: (text: string) => Promise<void>,
): Promise<void> {
  abortOwnedFeatureWatch(key)
  try {
    await interrupt()
  } catch {
    // A failed local interrupt does not skip the product pause attempt.
  }
  const owned = ownedFeatures.get(key)
  if (owned === undefined || owned.pausable !== true) return
  try {
    const paused = await workflow.requestFeatureSessionPause({
      cwd: owned.cwd,
      reason,
      interrupt,
      reference: owned.reference,
    })
    if (paused.kind === 'paused') {
      await report?.(paused.confirmed === true ? `pause-confirmed: ${paused.reason}` : pauseUnconfirmed(paused.reason))
    }
  } catch (error) {
    await report?.(`feature-stopped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

const actionStarts = new WeakMap<NativeBatch, ScopedRecordRef>()
const implementationStarts = new WeakMap<NativeBatch, string>()
const execGit = promisify(execFile)

function isImplementationBatch(batch: NativeBatch): boolean {
  return batch.tasks.tasks.some((task) => task.agent === 'R-workflow-implement')
}

async function readImplementationStart(
  host: FeatureCommandHost,
): Promise<{ ok: true; head: string } | { ok: false; reason: string }> {
  const git: FeatureGit =
    host.git ??
    (async (args, cwd) => {
      try {
        const shown = await execGit('git', [...args], { cwd, encoding: 'utf8' })
        return { stdout: observedGitText(shown.stdout), exitCode: 0 }
      } catch (error) {
        const stdout =
          typeof error === 'object' && error !== null && 'stdout' in error ? observedGitText(error.stdout) : ''
        const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : 1
        return { stdout, exitCode: typeof code === 'number' ? code : 1 }
      }
    })
  const head = await git(['rev-parse', 'HEAD'], host.cwd)
  const sha = head.stdout.trim()
  if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    return { ok: false, reason: 'implementation-start-unobserved' }
  }
  return { ok: true, head: sha }
}

function observedGitText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  return ''
}

export type FeatureGit = (args: readonly string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>

type ImplementationChild = {
  structured: Json | null
  bashCalls?: readonly NativeProofBashCall[]
}

function hostAdmission(
  reason: string,
  admitted = false,
  commands: HostEffectAdmission['commands'] = [],
  commits: string[] = [],
  paths: string[] = [],
): HostEffectAdmission {
  return {
    admitted,
    commits,
    paths,
    commands,
    remoteBranch: null,
    remoteTip: null,
    published: false,
    reason,
  }
}

export async function admitImplementationEvidence(input: {
  cwd: string
  startHead: string
  ticket: number
  children: readonly ImplementationChild[]
  git?: FeatureGit
}): Promise<HostEffectAdmission> {
  const git = input.git ?? defaultFeatureGit
  const parsed = implementationClaims(claimSource(input.children))
  if (!parsed.ok) return hostAdmission('')
  const claim = parsed.claim
  if (claim.outcome !== 'implemented' || claim.commitSHAs.length === 0 || claim.commands.length === 0) {
    return hostAdmission(claim.reason)
  }
  if (claim.proofToolCallId === null || claim.proofUnavailableReason !== null) return hostAdmission(claim.reason)
  const calls = input.children.flatMap((child) => child.bashCalls ?? [])
  const bound: HostEffectAdmission['commands'] = []
  const seen = new Set<string>()
  for (const command of claim.commands) {
    if (seen.has(command.toolCallId)) return hostAdmission(claim.reason, false, bound)
    seen.add(command.toolCallId)
    const match = bindClaimedCommand(command, calls, input.cwd)
    if (!match.ok) return hostAdmission(claim.reason, false, bound)
    bound.push(match.command)
  }
  const proof = bound.find((command) => command.toolCallId === claim.proofToolCallId)
  const proofCall = calls.find((call) => call.toolCallId === claim.proofToolCallId)
  if (proof === undefined || proof.exitCode !== 0 || proofCall === undefined || !foregroundCompletion(proofCall)) {
    return hostAdmission(claim.reason, false, bound)
  }
  const commits = await verifyOwnedLineage(input.cwd, input.startHead, claim.commitSHAs, git)
  if (!commits.ok) return hostAdmission(claim.reason, false, bound)
  if (!Number.isSafeInteger(input.ticket) || input.ticket <= 0) return hostAdmission(claim.reason, false, bound)
  if (!(await verifyTaskOwnedCommitSubjects(input.cwd, commits.commits, input.ticket, git))) {
    return hostAdmission(claim.reason, false, bound)
  }
  return hostAdmission(
    claim.reason,
    true,
    bound,
    commits.commits.map((commit) => commit.sha),
    [...new Set(commits.commits.flatMap((commit) => commit.paths))],
  )
}

function claimSource(children: readonly ImplementationChild[]): Json | null {
  const structured = children.flatMap((child) => (child.structured === null ? [] : [child.structured]))
  return structured.length === 1 ? structured[0] : null
}

function implementationClaims(value: Json | null):
  | {
      ok: true
      claim: {
        outcome: 'implemented' | 'blocked'
        commitSHAs: string[]
        commands: { command: string; exitCode: number; toolCallId: string }[]
        proofToolCallId: string | null
        proofUnavailableReason: string | null
        reason: string
      }
    }
  | { ok: false; reason: 'implementation-claim-missing' | 'implementation-command-unidentified' } {
  if (!objectRecord(value) || (value.outcome !== 'implemented' && value.outcome !== 'blocked')) {
    return { ok: false, reason: 'implementation-claim-missing' }
  }
  if (!Array.isArray(value.commitSHAs) || !value.commitSHAs.every((sha) => typeof sha === 'string')) {
    return { ok: false, reason: 'implementation-claim-missing' }
  }
  if (!Array.isArray(value.commands)) return { ok: false, reason: 'implementation-claim-missing' }
  if (typeof value.reason !== 'string') return { ok: false, reason: 'implementation-claim-missing' }
  const proofToolCallId = value.proofToolCallId
  const proofUnavailableReason = value.proofUnavailableReason
  if (proofToolCallId !== null && typeof proofToolCallId !== 'string') {
    return { ok: false, reason: 'implementation-claim-missing' }
  }
  if (proofUnavailableReason !== null && typeof proofUnavailableReason !== 'string') {
    return { ok: false, reason: 'implementation-claim-missing' }
  }
  const commands = []
  for (const command of value.commands) {
    if (
      !objectRecord(command) ||
      typeof command.command !== 'string' ||
      typeof command.exitCode !== 'number' ||
      !Number.isInteger(command.exitCode)
    ) {
      return { ok: false, reason: 'implementation-claim-missing' }
    }
    if (typeof command.toolCallId !== 'string' || command.toolCallId.length === 0) {
      return { ok: false, reason: 'implementation-command-unidentified' }
    }
    commands.push({ command: command.command, exitCode: command.exitCode, toolCallId: command.toolCallId })
  }
  return {
    ok: true,
    claim: {
      outcome: value.outcome,
      commitSHAs: value.commitSHAs,
      commands,
      proofToolCallId: proofToolCallId ?? null,
      proofUnavailableReason: proofUnavailableReason ?? null,
      reason: value.reason,
    },
  }
}

function foregroundCompletion(call: NativeProofBashCall): boolean {
  if (call.exitCode === null || call.result === null || !objectRecord(call.result)) return false
  const details = call.result.details
  if (!objectRecord(details)) return false
  if (
    details.async !== undefined ||
    details.service !== undefined ||
    details.terminalId !== undefined ||
    details.timedOut === true
  ) {
    return false
  }
  return true
}

function bindClaimedCommand(
  claim: { command: string; exitCode: number; toolCallId: string },
  calls: readonly NativeProofBashCall[],
  cwd: string,
): { ok: true; command: HostEffectAdmission['commands'][number] } | { ok: false; reason: string } {
  const matches = calls.filter((call) => call.toolCallId === claim.toolCallId)
  if (matches.length === 0) return { ok: false, reason: 'implementation-command-uncaptured' }
  if (matches.length !== 1) return { ok: false, reason: 'implementation-command-ambiguous' }
  const call = matches[0]
  if (call === undefined || !objectRecord(call.input) || typeof call.input.command !== 'string') {
    return { ok: false, reason: 'implementation-command-uncaptured' }
  }
  if (call.input.command !== claim.command) return { ok: false, reason: 'implementation-command-text-mismatch' }
  if (call.result === null || call.exitCode === null)
    return { ok: false, reason: 'implementation-command-exit-unobserved' }
  if (call.exitCode !== claim.exitCode) return { ok: false, reason: 'implementation-command-exit-mismatch' }
  if (call.effectiveCwd === null || !sameRealpath(call.effectiveCwd, cwd)) {
    return { ok: false, reason: 'implementation-command-cwd-unobserved' }
  }
  return {
    ok: true,
    command: { toolCallId: call.toolCallId, command: claim.command, exitCode: call.exitCode, cwd: call.effectiveCwd },
  }
}

async function verifyOwnedLineage(
  cwd: string,
  startHead: string,
  commitSHAs: readonly string[],
  git: FeatureGit,
): Promise<{ ok: true; commits: { sha: string; parent: string; paths: string[] }[] } | { ok: false; reason: string }> {
  const head = await git(['rev-parse', 'HEAD'], cwd)
  const status = await git(['status', '--porcelain'], cwd)
  const observedHead = head.stdout.trim()
  if (head.exitCode !== 0 || status.exitCode !== 0) return { ok: false, reason: 'implementation-git-unobserved' }
  if (status.stdout.trim() !== '') return { ok: false, reason: 'implementation-worktree-dirty' }
  if (commitSHAs.length === 0) {
    return observedHead === startHead
      ? { ok: true, commits: [] }
      : { ok: false, reason: 'implementation-unowned-commit' }
  }
  const commits = []
  let parent = startHead
  for (const sha of commitSHAs) {
    const verified = await git(['rev-parse', '--verify', `${sha}^{commit}`], cwd)
    const parents = await git(['rev-list', '--parents', '-n1', sha], cwd)
    const changed = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha], cwd)
    if (verified.exitCode !== 0 || parents.exitCode !== 0 || changed.exitCode !== 0) {
      return { ok: false, reason: 'implementation-git-unobserved' }
    }
    const tokens = parents.stdout.trim().split(/\s+/)
    const paths = changed.stdout.split('\n').filter(Boolean)
    if (
      verified.stdout.trim() !== sha ||
      tokens.length !== 2 ||
      tokens[0] !== sha ||
      tokens[1] !== parent ||
      paths.length === 0
    ) {
      return { ok: false, reason: 'implementation-lineage-unverified' }
    }
    commits.push({ sha, parent, paths })
    parent = sha
  }
  return observedHead === parent ? { ok: true, commits } : { ok: false, reason: 'implementation-unowned-commit' }
}

async function verifyTaskOwnedCommitSubjects(
  cwd: string,
  commits: readonly { sha: string }[],
  ticket: number,
  git: FeatureGit,
): Promise<boolean> {
  for (const commit of commits) {
    const subject = await git(['show', '-s', '--format=%s', commit.sha], cwd)
    const title = subject.stdout.trim()
    if (subject.exitCode !== 0 || titleType(title) === null || ticketOfSubject(title) !== ticket) return false
  }
  return true
}

async function defaultFeatureGit(args: readonly string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const { stdout } = await execGit('git', [...args], { cwd, encoding: 'utf8' })
    return { stdout: String(stdout), exitCode: 0 }
  } catch (error) {
    const failed = error as { stdout?: string; code?: number }
    return { stdout: String(failed.stdout ?? ''), exitCode: typeof failed.code === 'number' ? failed.code : 1 }
  }
}

function sameRealpath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

function objectRecord(value: unknown): value is Record<string, unknown> & {
  command?: unknown
  exitCode?: unknown
  outcome?: unknown
  commitSHAs?: unknown
  commands?: unknown
} {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
