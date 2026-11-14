import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import type { ContinueFeatureInput, FeatureCommandHost } from '../roxabi/feature-contract.ts'
import { claimStartActivation } from '../roxabi/feature-start-executions.ts'
import type { OperatorPort, PreparedOperatorProposal } from '../roxabi/uw-contract.ts'
import { installFixtureSdkSettings } from './native-sdk-settings-fixture.ts'

await installFixtureSdkSettings(process.argv[2] ?? '')
// Load the Feature modules (and their SDK registry) only after the fixture's SDK settings are installed.
const { loadFeatureWorkflow } = await import('../roxabi/feature-loader.ts')
const { createInstalledUwOperations } = await import('../roxabi/uw-installed-operations.ts')
const { createInstalledUwReadPort } = await import('../roxabi/uw-read-port.ts')

type Executor = 'settled' | 'busy' | 'unobserved' | 'missing' | 'known-unretained-terminal'
type OperatorMode =
  | 'confirm'
  | 'defer'
  | 'stale-commit'
  | 'stale-comment'
  | 'throw-before'
  | 'throw-after'
  | 'abandon-readback'
type Payload = {
  reference: string
  start: string | null
  executor: Executor
  operator: OperatorMode
  /** A framed record body appended between proposal and confirmation (stale-comment only). */
  inject: string | null
  /** Cross-scope factory probe: preserve the real PR START and mandate references. */
  startTarget: string | null
  mandateId: string | null
}

function field(raw: object, name: string): unknown {
  return name in raw ? (raw as Record<string, unknown>)[name] : undefined
}

function payloadFrom(raw: unknown): Payload {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('payload-invalid')
  const reference = field(raw, 'reference')
  const start = field(raw, 'start')
  const executor = field(raw, 'executor')
  const operator = field(raw, 'operator')
  const inject = field(raw, 'inject')
  const startTarget = field(raw, 'startTarget')
  const mandateId = field(raw, 'mandateId')
  if (typeof reference !== 'string' || reference.length === 0) throw new Error('payload-reference-invalid')
  if (
    executor !== 'settled' &&
    executor !== 'busy' &&
    executor !== 'unobserved' &&
    executor !== 'missing' &&
    executor !== 'known-unretained-terminal'
  )
    throw new Error('payload-executor-invalid')
  if (
    operator !== 'confirm' &&
    operator !== 'defer' &&
    operator !== 'stale-commit' &&
    operator !== 'stale-comment' &&
    operator !== 'throw-before' &&
    operator !== 'throw-after' &&
    operator !== 'abandon-readback'
  )
    throw new Error('payload-operator-invalid')
  return {
    reference,
    start: typeof start === 'string' ? start : null,
    executor,
    operator,
    startTarget: typeof startTarget === 'string' ? startTarget : null,
    mandateId: typeof mandateId === 'string' ? mandateId : null,
    inject: typeof inject === 'string' ? inject : null,
  }
}

const [cwd, payloadText] = process.argv.slice(2)
if (cwd === undefined) throw new Error('cwd-missing')
const payload = payloadFrom(JSON.parse(payloadText ?? '{}') as unknown)
const prompts: PreparedOperatorProposal[] = []
const observed: unknown[] = []

function appendSimComment(body: string): void {
  const stateFile = process.env.GH_SIM_STATE
  if (stateFile === undefined) throw new Error('simulator-state-missing')
  const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
    issues: Record<string, { comments: Array<{ author: string; body: string }> }>
  }
  const issue = state.issues['42']
  if (issue === undefined) throw new Error('simulated-issue-missing')
  issue.comments.push({ author: 'operator', body })
  writeFileSync(stateFile, JSON.stringify(state, null, 2))
}

/** Context-bound confirmation double: evidence is copied from the exact prepared proposal, like the native drive. */
const operator: OperatorPort = {
  async executeConfirmed(prepared, action) {
    prompts.push(structuredClone(prepared))
    if (payload.operator === 'throw-before') throw new Error('publication test failure')
    if (payload.operator === 'defer') {
      return {
        status: 'deferred',
        diagnostics: [
          {
            code: 'operator-confirmation-deferred',
            message: 'The confirming session was replaced',
            location: { kind: 'repository', repository: 'acme/app' },
            related: [],
          },
        ],
      }
    }
    if (payload.operator === 'stale-commit')
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'feat: concurrent change (#42)'], { cwd })
    if (payload.operator === 'stale-comment') {
      if (payload.inject === null) throw new Error('stale-comment-body-missing')
      appendSimComment(payload.inject)
    }
    const value = await action({
      route: 'omp-native-command',
      operationId: prepared.proposal.operationId,
      proposalDigest: prepared.digest,
      confirmedAt: '2026-11-14T12:00:00.000Z',
    })
    if (payload.operator === 'throw-after') throw new Error('publication test failure')
    return { status: 'confirmed', value }
  },
}

if (payload.start !== null) {
  const start = {
    scope: { repository: 'acme/app', target: payload.startTarget ?? 'acme/app#42' },
    recordId: payload.start,
    kind: 'action-receipt' as const,
  }
  if (payload.executor === 'settled') {
    // Exercise the host's real pre-activation fence in the same module graph as installed UW.
    const { batch, cleanupFixtureActions } = await import('./review-runtime-support.ts')
    const { announceFeatureBatch } = await import('../roxabi/feature-host-native.ts')
    const unexpected = (): never => {
      throw new Error('Unexpected fixture host port')
    }
    const host: FeatureCommandHost = {
      key: {},
      cwd,
      principal: false,
      workflow: {
        continueFeature: unexpected,
        consumeWatchExit: unexpected,
        publishFeatureNativeResult: unexpected,
        requestFeatureSessionPause: unexpected,
      },
      native: { activate: unexpected, inactive: unexpected, stopOwned: unexpected, announce: unexpected },
      async send() {},
      status: unexpected,
      startFraming: unexpected,
      inhibitFeatureContinuation: unexpected,
      releaseFeatureContinuation: unexpected,
      featureContinuationInhibited: () => true,
      markFeatureBatch: unexpected,
      exec: unexpected,
    }
    await announceFeatureBatch('42', batch(['slot-a']), start, host, async () => {})
    cleanupFixtureActions()
  }
  if (payload.executor === 'busy') claimStartActivation(start, 'fixture-admitted')
  if (payload.executor === 'known-unretained-terminal') {
    // Load SDK-backed fixtures only after the fixture's SDK settings are installed.
    const { batch, bridgeHarness, cleanupFixtureActions } = await import('./review-runtime-support.ts')
    const h = bridgeHarness()
    const prepared = batch(['slot-a'])
    if (!claimStartActivation(start, prepared.operationId)) throw new Error('fixture activation claim failed')
    const terminal = Promise.withResolvers<void>()
    h.controller.activate(prepared, {
      onComplete: async () => {
        throw new Error('fixture unexpectedly completed validly')
      },
      onStop: async (_reason, _binding, stop) => {
        if (stop.kind !== 'invalid-terminal') throw new Error(`unexpected fixture terminal: ${stop.kind}`)
        observed.push({ terminal: stop.kind })
        terminal.resolve()
      },
    })
    const root = {
      agent: { kind: 'main' as const, id: 'Main', name: 'main', depth: 0 },
      cwd,
      sessionManager: { getSessionId: () => 'unretained-terminal-fixture' },
      localProtocolOptions: { getArtifactsDir: () => cwd },
    }
    if (!(await h.admitBatch(prepared, 'unretained-terminal-call', root))) throw new Error('fixture admission failed')
    observed.push({ admitted: true })
    await h.admitChild(prepared, 'slot-a', 'slot-a', { root, skipRootCall: true })
    await h.settleBatch({
      toolCallId: 'unretained-terminal-call',
      errors: [],
      results: [
        {
          id: 'slot-a',
          index: 0,
          agent: 'R-review-adversarial',
          exitCode: 0,
        },
      ],
    })
    await terminal.promise
    cleanupFixtureActions()
  }
}

async function withAbandonOnFinalRead(
  cwd: string,
  operations: Awaited<ReturnType<typeof createInstalledUwOperations>>,
) {
  const { createUwInterruptionResolution } = await import('../roxabi/uw-interruption-resolution.ts')
  const { defaultGh } = await import('../roxabi/feature-engine.ts')
  const { withRoxabiGitHubPolicy } = await import('../roxabi/github-policy.ts')
  const { viewer, selectApplicableMandate, startResolution } = await import('../dist/contracts.js')
  const gh = defaultGh()
  const author = await viewer({ cwd, gh })
  const reader = createInstalledUwReadPort({ cwd, gh, readAuthor: author })
  async function readAfterAbandon(scope: Parameters<typeof reader.readUw>[0]) {
    const abandoned = await operations.abandon(scope)
    if (abandoned.status !== 'abandoned') throw new Error(`fixture abandon failed: ${JSON.stringify(abandoned)}`)
    const read = await reader.readUw(scope)
    if (read.observation.status !== 'complete') throw new Error('fixture final observation incomplete')
    const home = read.observation.histories.find(
      (entry) => entry.source.scope.repository === scope.repository && entry.source.scope.target === scope.target,
    )
    if (home === undefined) throw new Error('fixture final home missing')
    const selection = selectApplicableMandate(
      home,
      read.observation.histories.filter((entry) => entry !== home),
      {
        histories: read.observation.histories,
        catalogues: read.observation.catalogues,
        observation: read.observation,
      },
    )
    if (payload.start === null) throw new Error('fixture START missing')
    const historical = startResolution(read.observation.histories, {
      scope,
      recordId: payload.start,
      kind: 'action-receipt',
    })
    observed.push({
      abandon: abandoned.status,
      selection: selection.status === 'refused' ? selection.reason : selection.status,
      historicalResolution: historical.ok && historical.value !== null,
    })
    return read
  }
  let reads = 0
  const resolveInterruption = createUwInterruptionResolution({
    operator,
    github: withRoxabiGitHubPolicy({ cwd, gh, readAuthor: author, writerLogin: author }),
    reader: {
      async readUw(scope) {
        reads += 1
        if (reads === 3) return readAfterAbandon(scope)
        return reader.readUw(scope)
      },
    },
  })
  return { ...operations, resolveInterruption }
}

if (payload.startTarget !== null) {
  // The probe loads SDK-backed modules, so it must follow fixture SDK settings installation.
  const { probePrResolution } = await import('./feature-interruption-pr-probe.ts')
  await probePrResolution(cwd, { ...payload, startTarget: payload.startTarget }, prompts, observed)
} else {
  const workflow = await loadFeatureWorkflow()
  const installed = await createInstalledUwOperations({ cwd, operator })
  const uw = payload.operator === 'abandon-readback' ? await withAbandonOnFinalRead(cwd, installed) : installed
  const input = {
    cwd,
    reference: payload.reference,
    control: 'resolve-interruption',
    principal: false,
    read: createInstalledUwReadPort({ cwd }),
    uw,
    interruption: payload.start === null ? {} : { start: payload.start },
  } as unknown as ContinueFeatureInput
  const result = await workflow.continueFeature(input)
  process.stdout.write(`${JSON.stringify({ result, prompts, observed })}\n`)
}
