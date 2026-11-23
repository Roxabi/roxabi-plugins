import { describe, expect, it } from 'vitest'
import type { ContinueFeatureResult } from '../../roxabi/feature-contract.ts'
import { contextOf, installed, session, workflow } from '../../testing/feature-framing-runtime-fixture.ts'

const NOTHING_RUNNING =
  /\bnothing (?:is |was )?(?:running|executing|in progress)\b|\bno executor (?:is )?(?:running|active)\b/i

const UW_REF = 'acme/widgets#42'

function recording(result: ContinueFeatureResult) {
  const host = installed({ featureWorkflow: workflow(async () => result) })
  const ctx = contextOf(session())
  const statuses: Array<string | undefined> = []
  Object.assign(ctx.ui, {
    setStatus: (key: string, text: string | undefined) => {
      if (key === 'omp-build-watch') statuses.push(text)
    },
  })
  return { ...host, statuses, run: (args = UW_REF) => host.command(args, ctx) }
}

describe('feature business projection', () => {
  it('names the requested UW while /feature is still preparing', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const statuses: Array<[string, string | undefined]> = []
    const host = installed({
      featureWorkflow: workflow(async () => {
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

  it('never projects a plain uncertain action as nothing running', async () => {
    const recorded = recording({
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
    })
    await recorded.run()
    const status = recorded.statuses.at(-1)
    expect(status).toContain(UW_REF)
    expect(status).toContain('action-uncertain')
    for (const surface of [...recorded.messages, ...recorded.statuses])
      expect(surface ?? '').not.toMatch(NOTHING_RUNNING)
  })

  it('distinguishes done from a final stop', async () => {
    const done = recording({ kind: 'terminal', reason: 'done' })
    const finalStop = recording({ kind: 'terminal', reason: 'review-bound' })
    await done.run()
    await finalStop.run()
    expect(done.messages).toEqual(['feature-done: done'])
    expect(finalStop.messages).toEqual(['feature-stopped: review-bound'])
  })
})
