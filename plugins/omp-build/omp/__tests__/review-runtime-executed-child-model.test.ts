import { describe, expect, it, vi } from 'vitest'
import { unitSdkRoots } from '../../testing/unit-sdk-scopes.ts'
import { setup } from './review-runtime-executed-child.fixture.ts'

vi.mock('@oh-my-pi/pi-coding-agent', () => {
  return {
    SettingsManager: {
      create: (cwd: string) => {
        const value = unitSdkRoots.get(cwd)
        if (value instanceof Error) throw value
        if (value === undefined) throw new Error('settings unavailable')
        return { cwd }
      },
    },
  }
})

describe('root scoped authorized model route', () => {
  const authorized = { provider: 'trusted', id: 'selected-model' }

  it('accepts a child model matching the host-bound model', async () => {
    const fixture = await setup({ authorizedModel: authorized, childModel: { ...authorized } })
    await fixture.start()
    expect(await fixture.yieldValue()).toBeUndefined()
    await fixture.terminal()
    expect(fixture.onStop).not.toHaveBeenCalled()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it('blocks a child whose model shadows the root authorized model', async () => {
    const fixture = await setup({
      authorizedModel: authorized,
      childModel: { provider: 'shadow', id: authorized.id },
    })
    await fixture.start()
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
    expect(fixture.onStop).toHaveBeenCalledTimes(1)
  })

  it('blocks a child whose model ID differs from the host-bound model', async () => {
    const fixture = await setup({
      authorizedModel: authorized,
      childModel: { provider: authorized.provider, id: 'different-model' },
    })
    await fixture.start()
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
    expect(fixture.onStop).toHaveBeenCalledTimes(1)
  })

  it('uses each root’s own bound model rather than another root’s model', async () => {
    const secondModel = { provider: 'other', id: 'other-model' }
    const first = await setup({
      cwd: '/first-root',
      authorizedModel: authorized,
      childModel: { ...authorized },
      spawn: false,
    })
    const second = await setup({
      cwd: '/second-root',
      authorizedModel: secondModel,
      childModel: { ...secondModel },
      spawn: false,
    })
    expect(await first.spawn()).toBeUndefined()
    expect(await second.spawn()).toBeUndefined()
    await first.start()
    await second.start()
    expect(await first.yieldValue()).toBeUndefined()
    expect(await second.yieldValue()).toBeUndefined()
    await first.terminal()
    await second.terminal()
    expect(first.onStop).not.toHaveBeenCalled()
    expect(second.onStop).not.toHaveBeenCalled()
    expect(first.onComplete).toHaveBeenCalledTimes(1)
    expect(second.onComplete).toHaveBeenCalledTimes(1)
  })
})
