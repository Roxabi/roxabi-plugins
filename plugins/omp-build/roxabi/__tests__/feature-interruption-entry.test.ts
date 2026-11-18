import { afterEach, describe, expect, it } from 'vitest'
import type { ContinueFeatureInput, ContinueFeatureResult, FeatureCommandHost } from '../feature-contract.ts'
import { runInstalledFeatureCommand } from '../feature-entry.ts'
import { ownedFeatureFor, releaseFeatureOwner, rememberFeatureOwner } from '../feature-host-ownership.ts'

const keys: object[] = []
afterEach(() => {
  for (const key of keys.splice(0)) releaseFeatureOwner(key)
})

type Interruption = { start?: string }

function commandHost(
  result:
    | ContinueFeatureResult
    | ((input: ContinueFeatureInput) => ContinueFeatureResult | Promise<ContinueFeatureResult>),
  options: { initiallyInhibited?: boolean } = {},
) {
  const inputs: ContinueFeatureInput[] = []
  const sent: string[] = []
  const counters = { interrupts: 0, inhibited: 0, released: 0, stops: 0, activations: 0 }
  let inhibited = options.initiallyInhibited === true
  const key = {}
  keys.push(key)
  const host: FeatureCommandHost = {
    key,
    cwd: '/workspace',
    principal: false,
    workflow: {
      async continueFeature(input) {
        inputs.push(input)
        return typeof result === 'function' ? await result(input) : result
      },
      async consumeWatchExit() {
        throw new Error('unexpected watch')
      },
      async publishFeatureNativeResult() {
        throw new Error('resolution must not publish a native result')
      },
      async requestFeatureSessionPause() {
        throw new Error('resolution must not request a pause')
      },
    },
    native: {
      activate() {
        counters.activations += 1
      },
      inactive() {},
      async stopOwned() {
        counters.stops += 1
      },
      async announce() {
        throw new Error('resolution must not announce native work')
      },
    },
    async send(text) {
      sent.push(text)
    },
    status() {},
    async startFraming() {
      throw new Error('resolution must not start framing')
    },
    inhibitFeatureContinuation() {
      inhibited = true
      counters.inhibited += 1
    },
    releaseFeatureContinuation() {
      counters.released += 1
      if (!inhibited) return true
      inhibited = false
      return true
    },
    featureContinuationInhibited: () => inhibited,
    markFeatureBatch() {
      throw new Error('resolution must not mark native work')
    },
    async exec() {
      throw new Error('unexpected exec')
    },
    async interruptOwnedWork() {
      counters.interrupts += 1
    },
  }
  return { host, inputs, sent, counters, isInhibited: () => inhibited }
}
describe('/feature explicit context recovery entry', () => {
  it('passes the selected file to the workflow without starting work on a refusal', async () => {
    const { host, inputs, counters } = commandHost({ kind: 'blocked', reason: 'action-context-missing' })
    await runInstalledFeatureCommand('#42 --action /tmp/action.json', host)
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      reference: '42',
      control: 'recover-context',
      contextRecovery: { actionFile: '/tmp/action.json' },
    })
    expect(counters.activations).toBe(0)
  })

  it('completed context-negative: --action never releases the independently held latch', async () => {
    const { host, counters, isInhibited } = commandHost(
      { kind: 'blocked', reason: 'action-context-missing' },
      { initiallyInhibited: true },
    )
    await runInstalledFeatureCommand('#42 --action /tmp/action.json', host)
    expect(counters.released).toBe(0)
    expect(isInhibited()).toBe(true)
  })

  it('independent stop: --action keeps the held latch held', async () => {
    const { host, counters, isInhibited } = commandHost(
      { kind: 'terminal', reason: 'pause' },
      { initiallyInhibited: true },
    )
    await runInstalledFeatureCommand('#42 --action /tmp/held-action.json', host)
    expect(counters.released).toBe(0)
    expect(isInhibited()).toBe(true)
  })
})

describe('/feature generation-bound release modes', () => {
  it('confirmed resume → missing-context releases so a following --action is not stranded', async () => {
    const { host, counters, isInhibited, inputs } = commandHost(
      { kind: 'blocked', reason: 'action-context-missing' },
      { initiallyInhibited: true },
    )
    await runInstalledFeatureCommand('resume 42', host)
    expect(inputs[0]).toMatchObject({ control: 'resume' })
    expect(counters.released).toBe(1)
    expect(isInhibited()).toBe(false)

    await runInstalledFeatureCommand('#42 --action /tmp/action.json', host)
    expect(inputs[1]).toMatchObject({ control: 'recover-context' })
    expect(counters.released).toBe(1)
    expect(isInhibited()).toBe(false)
  })

  it('new admits only authenticated runnable results for release', async () => {
    const blocked = commandHost({ kind: 'blocked', reason: 'action-context-missing' }, { initiallyInhibited: true })
    await runInstalledFeatureCommand('new 42', blocked.host)
    expect(blocked.counters.released).toBe(0)
    expect(blocked.isInhibited()).toBe(true)

    const runnable = commandHost({ kind: 'review', pr: 7 }, { initiallyInhibited: true })
    await runInstalledFeatureCommand('new 42', runnable.host)
    expect(runnable.counters.released).toBe(1)
    expect(runnable.isInhibited()).toBe(false)
  })

  it('stale generation-bound unlock suppresses delivery for select', async () => {
    const { host, sent, counters } = commandHost({ kind: 'blocked', reason: 'action-context-missing' })
    host.releaseFeatureContinuation = () => {
      counters.released += 1
      return false
    }
    await runInstalledFeatureCommand('#42', host)
    expect(counters.released).toBe(1)
    expect(sent).toEqual([])
  })
})

describe('/feature resolve-interruption entry', () => {
  it('passes the explicit START, interrupts nothing, and never resumes', async () => {
    const { host, inputs, sent, counters } = commandHost({
      kind: 'paused',
      confirmed: true,
      reason: 'interruption-resolved',
    })
    const owner = { reference: '7', cwd: '/workspace', pausable: true }
    rememberFeatureOwner(host.key, owner)

    await runInstalledFeatureCommand('resolve-interruption #42 --start act-plan-1-start', host)

    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      cwd: '/workspace',
      reference: '42',
      control: 'resolve-interruption',
      principal: false,
      interruption: { start: 'act-plan-1-start' },
    })
    expect(counters).toEqual({ interrupts: 0, inhibited: 0, released: 0, stops: 0, activations: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('pause-confirmed: interruption-resolved')
    expect(sent[0]).toContain('/feature resume 42')
    expect(ownedFeatureFor(host.key)).toEqual(owner)
  })

  it('omits the START selector when none is given', async () => {
    const { host, inputs } = commandHost({ kind: 'paused', confirmed: true, reason: 'interruption-resolved' })

    await runInstalledFeatureCommand('resolve-interruption #42', host)

    const interruption = (inputs[0] as ContinueFeatureInput & { interruption?: Interruption }).interruption
    expect(interruption).toBeDefined()
    expect(interruption).not.toHaveProperty('start')
  })

  it.each(['interruption-dispatch-unproven', 'action-uncertain'])(
    'reports %s without claiming that nothing is running or taking over ownership',
    async (reason) => {
      const { host, inputs, sent, counters } = commandHost({
        kind: 'blocked',
        reason,
        diagnostics: [
          {
            code: reason,
            message: 'An executor of this START may still be running',
          },
        ],
      } as ContinueFeatureResult)
      const owner = { reference: '42', cwd: '/workspace', pausable: true }
      rememberFeatureOwner(host.key, owner)

      await runInstalledFeatureCommand('resolve-interruption #42', host)

      expect(inputs).toHaveLength(1)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toContain(reason)
      expect(sent[0]).not.toMatch(
        /nothing is running|rien ne tourne|aucun ex[ée]cutant (actif|ne tourne)|stopped cleanly/i,
      )
      expect(counters).toEqual({ interrupts: 0, inhibited: 0, released: 0, stops: 0, activations: 0 })
      expect(ownedFeatureFor(host.key)).toEqual(owner)
    },
  )

  it('refuses a malformed resolution command before any workflow call', async () => {
    const { host, inputs, sent } = commandHost({ kind: 'paused', confirmed: true, reason: 'interruption-resolved' })

    await runInstalledFeatureCommand('resolve-interruption #42 --start', host)

    expect(inputs).toEqual([])
    expect(sent).toEqual(['feature-stopped: feature-interruption-invalid'])
  })
})
