import { beforeEach, describe, expect, it } from 'vitest'
import type { ContinueFeatureResult, FeatureCommandHost, FeatureWorkflow } from '../../roxabi/feature-contract.ts'
import { deliverFeatureResult, runInstalledFeatureCommand } from '../../roxabi/feature-entry.ts'
import { ownedFeatureFor } from '../../roxabi/feature-host-ownership.ts'
import { createExtensionApiStub } from '../../testing/extension-api-stub.ts'
import {
  contextOf,
  installed as framingInstalled,
  workflow as framingWorkflow,
  session,
} from '../../testing/feature-framing-runtime-fixture.ts'
import { provisionNativeRoot } from '../../testing/native-root-fixture.ts'
import { consultableAgentRoot, consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import ompBuildExtension from '../index.ts'
import type { OmpBuildExtensionOptions } from '../omp-commands.ts'

/** Semantic classes of the feature status line, not pinned sentences. */
const HOLD = /\bheld\b|\bhold\b/i
const NOTHING_RUNNING =
  /\bnothing (?:is |was )?(?:running|executing|in progress)\b|\bno executor (?:is )?(?:running|active)\b/i
const WORKFLOW_SUCCESS = /\b(?:success(?:ful(?:ly)?)?|succeeded|passed|approved|done|completed?)\b/i

const UW_REF = 'acme/widgets#42'
const OTHER_REF = 'acme/widgets#43'
const WATCH = "bash '/repo/plugins/omp-build/skills/ci-watch/ci-watch.sh' '12' --merge-mode native --base 'main'"
const HELD: ContinueFeatureResult = { kind: 'blocked', reason: 'behind', next: 'update-branch-then-land' }

type Exit = { code: number; killed: boolean; stdout: string; stderr: string }

function baseWorkflow(impl: Partial<FeatureWorkflow> = {}): FeatureWorkflow {
  return {
    continueFeature: async () => ({ kind: 'blocked', reason: 'unconfigured' }),
    consumeWatchExit: async () => ({ kind: 'blocked', reason: 'watch-unconfigured' }),
    publishFeatureNativeResult: async () => {
      throw new Error('unexpected-native-publication')
    },
    requestFeatureSessionPause: async () => ({ kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }),
    ...impl,
  }
}

/** One feature command host; `status` is the existing `omp-build-watch` projection port. */
function recordingHost(impl: Partial<FeatureWorkflow> = {}, exec: () => Promise<Exit> = () => new Promise(() => {})) {
  const sent: string[] = []
  const statuses: Array<string | undefined> = []
  const host: FeatureCommandHost = {
    key: {},
    cwd: '/repo/feature',
    principal: false,
    workflow: baseWorkflow(impl),
    native: { activate() {}, inactive() {}, async stopOwned() {}, async announce() {} },
    send: async (text) => {
      sent.push(text)
    },
    status: (text) => {
      statuses.push(text)
    },
    startFraming: async () => {
      throw new Error('unexpected-framing')
    },
    inhibitFeatureContinuation() {},
    releaseFeatureContinuation() {},
    featureContinuationInhibited: () => false,
    markFeatureBatch() {},
    exec,
  }
  return { host, sent, statuses, projection: () => statuses.at(-1) }
}

function head(message: string | undefined): string {
  return (message ?? '').split('\n')[0]?.split(':')[0] ?? ''
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
}

const root = {
  ...consultableAgentRoot(),
  cwd: '/repo/feature',
  model: { contextWindow: 128_000 },
  isIdle: () => true,
}

beforeEach(() => {
  root.localProtocolOptions = consultableProtocolOptions()
  Object.assign(root.sessionManager, { getArtifactsDir: root.localProtocolOptions.getArtifactsDir })
})

/** The installed extension with one command context whose root session id the test can replace. */
function installedSessions(options: OmpBuildExtensionOptions, exec: () => Promise<Exit>) {
  const sent: string[] = []
  const statuses: Array<[string, string | undefined]> = []
  const commands = new Map<string, { handler: (args: string, ctx: typeof root) => Promise<void> }>()
  const pi = createExtensionApiStub({
    registerCommand: (name, command) => {
      commands.set(name, command as { handler: (args: string, ctx: typeof root) => Promise<void> })
    },
    sendUserMessage: (content) => {
      sent.push(String(content))
    },
    sendMessage: (message) => {
      sent.push(typeof message === 'string' ? message : String(message?.content ?? message))
    },
    exec,
  })
  provisionNativeRoot(root)
  const origin = { sessionId: root.sessionManager.getSessionId() }
  const context = {
    ...root,
    sessionManager: {
      ...root.sessionManager,
      getSessionId: () => origin.sessionId,
      getCwd: () => root.cwd,
    },
    ui: { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) },
  }
  ompBuildExtension(pi, { principalCwd: () => false, ...options })
  return {
    pi,
    sent,
    origin,
    feature: async (args: string) => {
      const command = commands.get('feature')
      if (command === undefined) throw new Error('feature-command-missing')
      await command.handler(args, context)
    },
    featureStatus: () => statuses.filter(([key]) => key === 'omp-build-watch').map(([, text]) => text),
  }
}

describe('feature business projection', () => {
  it('names the requested UW while /feature is still preparing', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const statuses: Array<[string, string | undefined]> = []
    const host = framingInstalled({
      featureWorkflow: framingWorkflow(async () => {
        entered.resolve()
        await release.promise
        return { kind: 'blocked', reason: 'fixture-blocked' }
      }),
    })
    const ctx = contextOf(session())
    Object.assign(ctx.ui, { setStatus: (key: string, text: string | undefined) => statuses.push([key, text]) })
    const running = host.command('#12', ctx)
    await entered.promise
    try {
      const preparing = statuses.filter(([key]) => key === 'omp-build-operator').at(-1)?.[1]
      expect(preparing).toMatch(/(?:#|\b)12\b/)
    } finally {
      release.resolve()
      await running
    }
  })

  it('projects a CI watch as the UW waiting on its landing PR checks and keeps the idle-Esc contract', async () => {
    const recorded = recordingHost()

    await deliverFeatureResult(UW_REF, { kind: 'watch', command: WATCH }, recorded.host)

    const status = recorded.projection()
    expect(status).toContain(UW_REF)
    expect(status).toMatch(/\b12\b/)
    expect(status).toMatch(/ci-watch|CI watch/i)
    expect(status).toMatch(/\bnext\b/i)
    expect(status).toContain('Idle Esc/RPC does not pause or disarm this watch')
    expect(status).toContain('/feature pause')
    expect(status).toContain('/feature abandon')
  })

  it('projects a recoverable hold with its UW, reason and next decision while the owner stays pausable', async () => {
    const recorded = recordingHost()

    await deliverFeatureResult(UW_REF, HELD, recorded.host)

    expect(recorded.sent).toHaveLength(1)
    expect(recorded.sent[0]).toContain('next: update-branch-then-land')
    expect(ownedFeatureFor(recorded.host.key)).toMatchObject({ reference: UW_REF, pausable: true })
    const status = recorded.projection()
    expect(status).toContain(UW_REF)
    expect(status).toMatch(HOLD)
    expect(status).toContain('behind')
    expect(status).toContain('update-branch-then-land')
  })

  it('never projects a plain uncertain action as nothing running', async () => {
    const recorded = recordingHost()
    const uncertain: ContinueFeatureResult = {
      kind: 'blocked',
      reason: 'action-uncertain',
      diagnostics: [
        {
          code: 'action-uncertain',
          message: 'plan start has no result',
          recordId: 'plan-start',
          detail: { action: 'plan' },
        },
      ],
    }

    await deliverFeatureResult(UW_REF, uncertain, recorded.host)

    expect(ownedFeatureFor(recorded.host.key)).toMatchObject({ reference: UW_REF, pausable: false })
    const status = recorded.projection()
    expect(status).toContain(UW_REF)
    expect(status).toContain('action-uncertain')
    for (const surface of [...recorded.sent, ...recorded.statuses]) expect(surface ?? '').not.toMatch(NOTHING_RUNNING)
  })

  it('does not claim an executor is idle when an interruption resolution is busy', async () => {
    const recorded = recordingHost()
    await deliverFeatureResult(UW_REF, { kind: 'blocked', reason: 'interruption-owner-busy' }, recorded.host)
    expect(recorded.projection()).toContain('interruption-owner-busy')
    for (const surface of [...recorded.sent, ...recorded.statuses]) expect(surface ?? '').not.toMatch(NOTHING_RUNNING)
  })

  it('distinguishes done from a final stop and releases the owner of both', async () => {
    const done = recordingHost()
    const finalStop = recordingHost()

    await deliverFeatureResult(UW_REF, { kind: 'terminal', reason: 'done' }, done.host)
    await deliverFeatureResult(UW_REF, { kind: 'terminal', reason: 'review-bound' }, finalStop.host)

    expect(done.sent).toHaveLength(1)
    expect(finalStop.sent).toHaveLength(1)
    expect(head(done.sent[0])).not.toBe(head(finalStop.sent[0]))
    expect(head(done.sent[0])).not.toMatch(/stop/i)
    expect(done.sent[0]).toContain('done')
    expect(finalStop.sent[0]).toContain('review-bound')
    expect(ownedFeatureFor(done.host.key)).toBeUndefined()
    expect(ownedFeatureFor(finalStop.host.key)).toBeUndefined()
  })

  it('clears the hold projection once the same UW is done', async () => {
    const recorded = recordingHost()
    await deliverFeatureResult(UW_REF, HELD, recorded.host)
    expect(recorded.projection()).toContain(UW_REF)

    await deliverFeatureResult(UW_REF, { kind: 'terminal', reason: 'done' }, recorded.host)

    expect(recorded.projection()).toBeUndefined()
    expect(ownedFeatureFor(recorded.host.key)).toBeUndefined()
  })

  it('keeps a confirmed interruption resolution a pause that still needs an explicit resume', async () => {
    const recorded = recordingHost()

    await deliverFeatureResult(
      UW_REF,
      { kind: 'paused', confirmed: true, reason: 'interruption-resolved' },
      recorded.host,
    )

    expect(recorded.sent).toHaveLength(1)
    expect(recorded.sent[0]).toContain('interruption-resolved')
    expect(recorded.sent[0]).toMatch(/\bpause/i)
    expect(recorded.sent[0]).not.toMatch(WORKFLOW_SUCCESS)
    expect(ownedFeatureFor(recorded.host.key)).toMatchObject({ reference: UW_REF, pausable: false })
    const status = recorded.projection()
    expect(status).toContain(UW_REF)
    expect(status).toMatch(/\bpaused\b/i)
    expect(status).toContain('interruption-resolved')
    expect(status).toContain(`/feature resume ${UW_REF}`)
    expect(status).not.toMatch(WORKFLOW_SUCCESS)
    expect(status).not.toMatch(/\bresumed\b/i)
  })

  it('reports interruption resolution without taking an unrelated owner or projection', async () => {
    const recorded = recordingHost({
      continueFeature: async () => ({ kind: 'paused', confirmed: true, reason: 'interruption-resolved' }),
    })
    await deliverFeatureResult(OTHER_REF, HELD, recorded.host)
    const owner = ownedFeatureFor(recorded.host.key)
    const before = recorded.projection()
    await runInstalledFeatureCommand(`resolve-interruption ${UW_REF}`, recorded.host)
    expect(ownedFeatureFor(recorded.host.key)).toBe(owner)
    expect(recorded.projection()).toBe(before)
    expect(recorded.sent.at(-1)).toContain(`/feature resume ${UW_REF}`)
  })

  it('does not deliver a watch result after a replacement during exit consumption', async () => {
    const exit = Promise.withResolvers<Exit>()
    const consumed = Promise.withResolvers<ContinueFeatureResult>()
    const entered = Promise.withResolvers<void>()
    const recorded = recordingHost(
      {
        consumeWatchExit: async () => {
          entered.resolve()
          return consumed.promise
        },
      },
      () => exit.promise,
    )
    await deliverFeatureResult(UW_REF, { kind: 'watch', command: WATCH }, recorded.host)
    exit.resolve({ code: 1, killed: false, stdout: '', stderr: '' })
    await entered.promise
    await deliverFeatureResult(OTHER_REF, HELD, recorded.host)
    const before = recorded.projection()
    const owner = ownedFeatureFor(recorded.host.key)
    consumed.resolve({ kind: 'blocked', reason: 'failed-checks' })
    await flush()
    expect(recorded.projection()).toBe(before)
    expect(ownedFeatureFor(recorded.host.key)).toBe(owner)
    expect(recorded.sent.join('\n')).not.toContain('failed-checks')
  })

  it('does not let a replaced UW watch exit rewrite the newer UW projection or owner', async () => {
    const exit = Promise.withResolvers<Exit>()
    const recorded = recordingHost({}, () => exit.promise)
    await deliverFeatureResult(UW_REF, { kind: 'watch', command: WATCH }, recorded.host)
    await deliverFeatureResult(OTHER_REF, HELD, recorded.host)
    // A replaced watch must preserve whatever the newer UW currently projects.
    const before = recorded.projection()
    expect(before).toBeDefined()
    expect(ownedFeatureFor(recorded.host.key)).toMatchObject({ reference: OTHER_REF, pausable: true })

    exit.resolve({ code: 1, killed: false, stdout: '', stderr: '' })
    await flush()

    expect(recorded.projection()).toBe(before)
    expect(ownedFeatureFor(recorded.host.key)).toMatchObject({ reference: OTHER_REF, pausable: true })
  })

  it('keeps the new session UW projection and owner when an old-session watch exits late', async () => {
    const exit = Promise.withResolvers<Exit>()
    const featureWorkflow = baseWorkflow({
      continueFeature: async (input) => (input.reference === '42' ? { kind: 'watch', command: WATCH } : HELD),
      consumeWatchExit: async () => ({ kind: 'blocked', reason: 'failed-checks' }),
    })
    const host = installedSessions({ featureWorkflow }, () => exit.promise)
    await host.feature('#42')
    host.origin.sessionId = 'session-after-new'
    await host.feature('#43')
    // An old-session watch must preserve whatever the new session currently projects.
    const before = host.featureStatus().at(-1)
    expect(before).toBeDefined()
    expect(ownedFeatureFor(host.pi)).toMatchObject({ reference: '43', pausable: true })

    exit.resolve({ code: 1, killed: false, stdout: '', stderr: '' })
    await flush()

    expect(host.featureStatus().at(-1)).toBe(before)
    expect(ownedFeatureFor(host.pi)).toMatchObject({ reference: '43', pausable: true })
    expect(host.sent.join('\n')).not.toContain('failed-checks')
  })
})
