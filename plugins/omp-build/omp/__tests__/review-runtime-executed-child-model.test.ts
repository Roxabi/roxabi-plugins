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

const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Continuing the assignment.' }], timestamp: 2 }
const reminder = {
  role: 'developer',
  content: [{ type: 'text', text: '<system-reminder>\nReminder 1 of 3.\n</system-reminder>' }],
  attribution: 'agent',
  synthetic: true,
  timestamp: 3,
}

describe('native child model fallback', () => {
  const role = { provider: 'primary', id: 'role-model' }

  it('admits a child that starts on the fallback model instead of the role model', async () => {
    const fixture = await setup({ authorizedModel: role, childModel: { provider: 'fallback', id: 'backup-model' } })
    await fixture.start()
    expect(fixture.runtime.provider).toHaveBeenCalledTimes(1)
    expect(await fixture.yieldValue()).toBeUndefined()
    await fixture.terminal()
    expect(fixture.abort).not.toHaveBeenCalled()
    expect(fixture.onStop).not.toHaveBeenCalled()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it.each(['provider retry', 'next turn'] as const)(
    'keeps a child whose model falls back mid-run through %s, yield, shutdown and completion',
    async (path) => {
      const fixture = await setup({ authorizedModel: role, childModel: { ...role } })
      await fixture.start()
      fixture.child.model.provider = 'fallback'
      fixture.child.model.id = 'backup-model'
      if (path === 'provider retry') {
        await fixture.context([fixture.initialMessage])
        await fixture.provider()
      } else await fixture.continueTurn('Reminder 1 of 3.', [fixture.initialMessage, assistant, reminder])
      expect(fixture.abort).not.toHaveBeenCalled()
      expect(fixture.runtime.provider).toHaveBeenCalledTimes(2)
      expect(await fixture.yieldValue()).toBeUndefined()
      fixture.lifecycle({ status: 'completed' })
      await fixture.childEndpoint.emit('session_shutdown', { type: 'session_shutdown' }, fixture.child)
      await fixture.terminal()
      expect(fixture.abort).not.toHaveBeenCalled()
      expect(fixture.onStop).not.toHaveBeenCalled()
      expect(fixture.onComplete).toHaveBeenCalledTimes(1)
    },
  )

  it('completes each root’s own child independently', async () => {
    const secondModel = { provider: 'other', id: 'other-model' }
    const first = await setup({ cwd: '/first-root', authorizedModel: role, childModel: { ...role }, spawn: false })
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
