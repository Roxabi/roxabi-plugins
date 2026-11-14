import { afterEach, describe, expect, it } from 'vitest'
import type { ContinueFeatureInput, ContinueFeatureResult, FeatureCommandHost } from '../feature-contract.ts'
import { runInstalledFeatureCommand } from '../feature-entry.ts'
import { ownedFeatureFor, releaseFeatureOwner, rememberFeatureOwner } from '../feature-host-ownership.ts'

const keys: object[] = []
afterEach(() => {
  for (const key of keys.splice(0)) releaseFeatureOwner(key)
})

type Interruption = { start?: string }

function commandHost(result: ContinueFeatureResult) {
  const inputs: ContinueFeatureInput[] = []
  const sent: string[] = []
  const counters = { interrupts: 0, inhibited: 0, released: 0, stops: 0, activations: 0 }
  const key = {}
  keys.push(key)
  const host: FeatureCommandHost = {
    key,
    cwd: '/workspace',
    principal: false,
    workflow: {
      async continueFeature(input) {
        inputs.push(input)
        return result
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
      counters.inhibited += 1
    },
    releaseFeatureContinuation() {
      counters.released += 1
    },
    featureContinuationInhibited: () => false,
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
  return { host, inputs, sent, counters }
}

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
