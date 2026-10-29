import { describe, expect, it, vi } from 'vitest'
import { unitSdkRoots } from '../../testing/unit-sdk-scopes.ts'
import { agent, setup } from './review-runtime-executed-child.fixture.ts'

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
  const overrides = { [agent]: [' unavailable/model ', ' trusted/selected-model '] }

  it('resolves the ordered override at the root and accepts an equivalent child model', async () => {
    const fixture = await setup({
      settings: overrides,
      resolve: (selector) => (selector === 'unavailable/model,trusted/selected-model' ? authorized : undefined),
      childModel: { ...authorized },
    })
    await fixture.start()
    expect(await fixture.yieldValue()).toBeUndefined()
    await fixture.terminal()
    expect(fixture.onStop).not.toHaveBeenCalled()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it('blocks a child whose model shadows the root authorized model', async () => {
    const fixture = await setup({
      settings: overrides,
      resolve: () => authorized,
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

  it.each([[], ['', '  '], '  '])('uses the pinned role for empty override %j', async (override) => {
    const fixture = await setup({ settings: { [agent]: override } })
    await fixture.start()
    expect(await fixture.yieldValue()).toBeUndefined()
    await fixture.terminal()
    expect(fixture.onStop).not.toHaveBeenCalled()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['unavailable settings', undefined],
    ['settings read failure', new Error('settings unavailable')],
    ['malformed override', { [agent]: ['valid/model', 42] }],
  ])('fails closed for %s', async (_label, settings) => {
    const fixture = await setup({ settings, spawn: false })
    expect(await fixture.spawn()).toEqual({ block: true, reason: 'native child model route unavailable' })
  })

  it('fails closed when the root model facade cannot resolve the override', async () => {
    const fixture = await setup({ settings: overrides, resolve: () => undefined, spawn: false })
    expect(await fixture.spawn()).toEqual({ block: true, reason: 'native child model route unavailable' })
  })

  it('uses each root’s scoped settings rather than another root’s override', async () => {
    const first = await setup({
      cwd: '/first-root',
      settings: { [agent]: ['first/model'] },
      resolve: (selector) => (selector === 'first/model' ? authorized : undefined),
      childModel: { ...authorized },
      spawn: false,
    })
    const second = await setup({
      cwd: '/second-root',
      settings: { [agent]: ['second/model'] },
      resolve: (selector) => (selector === 'second/model' ? authorized : undefined),
      childModel: { ...authorized },
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
