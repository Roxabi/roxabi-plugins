import { describe, expect, it, vi } from 'vitest'
import { unitSdkRoots } from '../../testing/unit-sdk-scopes.ts'
import { data, setup, taskText } from './review-runtime-executed-child.fixture.ts'

vi.mock('@oh-my-pi/pi-coding-agent', () => ({
  SettingsManager: {
    create: (cwd: string) => {
      const value = unitSdkRoots.get(cwd)
      if (value instanceof Error) throw value
      if (value === undefined) throw new Error('settings unavailable')
      return { cwd }
    },
  },
}))

const reminder =
  '<system-reminder>\nLast turn had no tool call → session idle. Reminder 1 of 3.\n\nEvery turn MUST end with a tool call.\n</system-reminder>'
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'Continuing the assignment.' }], timestamp: 2 }
const developer = {
  role: 'developer',
  content: [{ type: 'text', text: reminder }],
  attribution: 'agent',
  synthetic: true,
  timestamp: 3,
}
const steering = {
  role: 'user',
  content: 'Account for the latest result.',
  attribution: 'agent',
  steering: true,
  timestamp: 4,
}

describe('native executed-child continuation guard', () => {
  it.each([
    ['synthetic developer yield reminder', reminder, developer],
    ['agent-attributed user steering', steering.content, steering],
  ])('admits a second provider turn and guarded yield after %s', async (_label, text, control) => {
    const fixture = await setup()
    await fixture.start({ retries: 2 })
    expect(fixture.runtime.provider).toHaveBeenCalledTimes(1)
    await fixture.continueTurn(text, [fixture.initialMessage, assistant, control])
    expect(fixture.abort).not.toHaveBeenCalled()
    expect(fixture.runtime.provider).toHaveBeenCalledTimes(2)
    expect(await fixture.yieldValue()).toBeUndefined()
    expect(fixture.runtime.tool).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.yield).toHaveBeenCalledTimes(1)
    await fixture.terminal()
    expect(fixture.onStop).not.toHaveBeenCalled()
    expect(fixture.onComplete).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['human user', { ...steering, attribution: 'user' }],
    ['unattributed user', { role: 'user', content: steering.content, timestamp: 4 }],
    ['unknown user attribution', { ...steering, attribution: 'unknown' }],
    ['human developer', { ...developer, attribution: 'user' }],
    ['unattributed developer', { role: 'developer', content: reminder, synthetic: true, timestamp: 3 }],
    ['unknown developer attribution', { ...developer, attribution: 'unknown' }],
  ])('refuses %s before another provider, tool or yield', async (_label, control) => {
    const fixture = await setup()
    await fixture.start()
    await fixture.continueTurn('Account for the latest result.', [fixture.initialMessage, assistant, control])
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).toHaveBeenCalledTimes(1)
    await fixture.yieldValue()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    expect(fixture.runtime.yield).not.toHaveBeenCalled()
    expect(
      await fixture.childEndpoint.emit(
        'tool_call',
        { type: 'tool_call', toolName: 'yield', toolCallId: 'after-refusal', input: { data } },
        fixture.child,
      ),
    ).toMatchObject({ block: true })
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
  })

  it.each([
    ['substituted first preflight', { prompt: 'different assignment' }],
    [
      'substituted first context',
      { messages: [{ role: 'user', content: 'different assignment', attribution: 'agent', timestamp: 1 }] },
    ],
    ['human first context', { messages: [{ role: 'user', content: taskText, attribution: 'user', timestamp: 1 }] }],
    ['unattributed first context', { messages: [{ role: 'user', content: taskText, timestamp: 1 }] }],
    [
      'developer before first task',
      { messages: [developer, { role: 'user', content: taskText, attribution: 'agent', timestamp: 1 }] },
    ],
  ])('refuses %s before initial provider, tool or yield', async (_label, options) => {
    const fixture = await setup()
    await fixture.start(options)
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    expect(fixture.runtime.yield).not.toHaveBeenCalled()
    await fixture.terminal()
    expect(fixture.onComplete).not.toHaveBeenCalled()
  })

  it('does not admit a different prompt during initial preflight retry', async () => {
    const fixture = await setup()
    await fixture.childEndpoint.emit('session_start', { type: 'session_start' }, fixture.child)
    await fixture.preflight(taskText)
    await fixture.preflight('substituted assignment')
    await fixture.context([fixture.initialMessage])
    await fixture.provider()
    await fixture.yieldValue()
    expect(fixture.abort).toHaveBeenCalledTimes(1)
    expect(fixture.runtime.provider).not.toHaveBeenCalled()
    expect(fixture.runtime.tool).not.toHaveBeenCalled()
    expect(fixture.runtime.yield).not.toHaveBeenCalled()
  })

  it.each(['unbound', 'root', 'model', 'tools', 'first task'] as const)(
    'refuses continuation with %s drift before another provider, tool or yield',
    async (drift) => {
      const fixture = await setup()
      await fixture.start()
      if (drift === 'unbound') fixture.setSession('different-child-session')
      if (drift === 'root') await fixture.switchRoot()
      if (drift === 'model') fixture.child.model.id = 'different-model'
      if (drift === 'tools') fixture.childEndpoint.addTool('bash')
      const first =
        drift === 'first task' ? { ...fixture.initialMessage, content: 'different assignment' } : fixture.initialMessage
      await fixture.continueTurn(reminder, [first, assistant, developer])
      await fixture.yieldValue()
      expect(fixture.abort).toHaveBeenCalledTimes(1)
      expect(fixture.runtime.provider).toHaveBeenCalledTimes(1)
      expect(fixture.runtime.tool).not.toHaveBeenCalled()
      expect(fixture.runtime.yield).not.toHaveBeenCalled()
      await fixture.terminal()
      expect(fixture.onComplete).not.toHaveBeenCalled()
    },
  )
})
