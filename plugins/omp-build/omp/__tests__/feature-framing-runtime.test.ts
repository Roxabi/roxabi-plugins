import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it, vi } from 'vitest'
import type { ContinueFeatureResult } from '../../roxabi/feature-contract.ts'
import { FRAMING_SUBMIT_TOOL } from '../../roxabi/feature-framing-contract.ts'
import { fixtureUwOperations } from '../../testing/action-input-fixtures.ts'
import {
  CHILD_AGENT,
  CWD,
  confirmationProposal,
  contextOf,
  installed,
  session,
  toolInfo,
  workflow,
} from '../../testing/feature-framing-runtime-fixture.ts'
import { manualOperatorDialog } from '../../testing/operator-dialog-ui.ts'
import { consultableProtocolOptions } from '../../testing/protocol-retention.unit.ts'
import { fixture as uwFixture } from '../../testing/uw-operations-fixture.ts'
import { UW } from '../../testing/uw-operations-fixture-input.ts'
import * as operatorConfirmation from '../omp-operator-confirmation.ts'
import { createOperatorConfirmation } from '../omp-operator-confirmation.ts'

const realCreateOperatorConfirmation = operatorConfirmation.createOperatorConfirmation

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function contextEvent() {
  return { type: 'context', messages: [{ role: 'user', content: 'Frame the billing export', timestamp: 1 }] }
}

function captureCommandPort() {
  let port: operatorConfirmation.CommandOperatorPort | undefined
  const spy = vi.spyOn(operatorConfirmation, 'createOperatorConfirmation').mockImplementation((ctx, options) => {
    port = realCreateOperatorConfirmation(ctx, options)
    return port
  })
  return {
    port() {
      if (port === undefined) throw new Error('command-operator-missing')
      return port
    },
    restore: () => spy.mockRestore(),
  }
}

async function interviewing(host: ReturnType<typeof installed>, root: ExtensionContext, args: string) {
  await host.command(args, root)
  if (host.userMessages.length === 0) throw new Error('framing-interview-not-started')
}

describe('assisted /feature framing in the installed extension', () => {
  it('frames free text in the same turn with the exact command text', async () => {
    const host = installed()
    const root = contextOf(session())
    const args = '  ship  the billing export '

    await host.command(args, root)

    expect(host.userMessages).toEqual([{ content: args, options: { attribution: 'user' } }])
    expect(host.procedureReads()).toBe(1)
  })

  it('admits only built-in read tools and the submit tool while framing, ahead of the missing-contract bypass', async () => {
    const host = installed()
    const root = contextOf(session())
    // No project contract exists at CWD, so outside framing every tool passes the guards.
    expect(await host.admits('bash', root)).toBe(true)

    await interviewing(host, root, 'ship the billing export')

    for (const name of ['read', 'grep', 'glob', FRAMING_SUBMIT_TOOL]) expect(await host.admits(name, root)).toBe(true)
    for (const name of ['bash', 'write', 'edit', 'task', 'mcp__files_read', 'omp_build_start_review', 'unknown_tool'])
      expect(await host.admits(name, root)).toBe(false)
  })

  it('denies same-named tools of another provenance and denies everything when metadata is unreadable', async () => {
    let unreadable = false
    const host = installed({
      tools: () => {
        if (unreadable) throw new Error('tool-metadata-unavailable')
        return [
          toolInfo('read', 'builtin', '<builtin:read>'),
          toolInfo('grep', 'extension', '/elsewhere/grep.ts'),
          toolInfo(FRAMING_SUBMIT_TOOL, 'extension', '/elsewhere/framing-submit.ts'),
        ]
      },
    })
    const root = contextOf(session())
    await interviewing(host, root, 'ship the billing export')

    expect(await host.admits('read', root)).toBe(true)
    expect(await host.admits('grep', root)).toBe(false)
    expect(await host.admits(FRAMING_SUBMIT_TOOL, root)).toBe(false)
    unreadable = true
    expect(await host.admits('read', root)).toBe(false)
  })

  it('projects the framing procedure only into the governed root context', async () => {
    const host = installed()
    const state = session()
    const root = contextOf(state)
    await interviewing(host, root, 'ship the billing export')
    const event = contextEvent()

    expect(await host.emit('context', event, root)).toMatchObject({
      messages: [event.messages[0], { role: 'custom', display: false }],
    })
    expect(await host.emit('context', contextEvent(), contextOf(state, CHILD_AGENT))).toBeUndefined()
    expect(await host.emit('context', contextEvent(), contextOf(session('other-session')))).toBeUndefined()
  })

  it('refuses a malformed form read-only and keeps the interview', async () => {
    const host = installed()
    const root = contextOf(session())
    await interviewing(host, root, 'ship the billing export')

    expect(await host.submit({ form: { kind: 'bogus' } }, root, new AbortController().signal)).toMatchObject({
      status: 'refused',
    })
    expect(await host.emit('context', contextEvent(), root)).toBeDefined()
  })

  it('refuses the submit tool outside a governed root framing call', async () => {
    const host = installed()
    const state = session()
    const root = contextOf(state)
    const signal = new AbortController().signal

    await expect(host.submit({}, root, signal)).rejects.toThrow()
    await interviewing(host, root, 'ship the billing export')
    await expect(host.submit({}, contextOf(state, CHILD_AGENT), signal)).rejects.toThrow()
    await expect(host.submit({}, root)).rejects.toThrow()
  })

  it('opens no confirmation from the shortcut while nothing is staged', async () => {
    const host = installed()
    const state = session()
    const root = contextOf(state)
    await interviewing(host, root, 'ship the billing export')

    await host.shortcut(root)

    expect(state.confirms).toBe(0)
    expect(await host.emit('context', contextEvent(), root)).toBeDefined()
  })

  it('reopens a held generic confirmation from the shortcut while busy and does not start framing', async () => {
    const host = installed()
    const state = session()
    state.idle = false
    const dialog = manualOperatorDialog()
    const root = contextOf(state)
    Object.assign(root, { ui: dialog.ui, hasPendingMessages: () => true })
    const operator = createOperatorConfirmation(root)
    const effects: string[] = []
    const pending = operator.executeConfirmed(
      {
        digest: '1c6e37f6c1d14723bc8d8e4b5565d928',
        proposal: {
          operationId: 'normalize-acme-widgets-42',
          operation: 'normalize',
          target: { kind: 'existing', uw: { repository: 'acme/widgets', target: 'acme/widgets#42' } },
        },
      } as never,
      async () => {
        effects.push('once')
        return 'once'
      },
    )
    const first = await dialog.nextMount()
    first.handleInput?.('\u001b')
    await operator.held
    const reads = host.procedureReads()
    await host.shortcut(root)
    expect(host.procedureReads()).toBe(reads)
    const reopened = await dialog.nextMount()
    reopened.handleInput?.('c')
    await expect(pending).resolves.toMatchObject({ status: 'confirmed', value: 'once' })
    expect(effects).toEqual(['once'])
  })
})

describe('/feature intake before classification', () => {
  it.each(['blocked', 'framing'] as const)(
    'keeps a held intake read-only until its actual %s classification',
    async (classification) => {
      const source = uwFixture()
      const captured = captureCommandPort()
      const dialog = manualOperatorDialog()
      const effects: string[] = []
      const host = installed({
        uwOperations: () => ({ ...fixtureUwOperations(), readUw: source.operations.readUw }),
        featureWorkflow: workflow(async () => {
          await captured.port().executeConfirmed(confirmationProposal, async () => {
            effects.push('authorized')
            return 'accepted'
          })
          return classification === 'blocked'
            ? { kind: 'blocked', reason: 'fixture-blocked' }
            : {
                kind: 'framing',
                source: { kind: 'issue', uw: UW },
              }
        }),
      })
      const root = contextOf(session())
      Object.assign(root.ui, dialog.ui)
      try {
        const running = host.command('#42', root)
        const first = await dialog.nextMount()
        first.handleInput?.('\u001b')
        await running
        expect(await host.admits('bash', root)).toBe(false)
        expect(await host.admits('read', root)).toBe(true)
        expect(effects).toEqual([])
        await host.shortcut(root)
        const reopened = await dialog.nextMount()
        reopened.handleInput?.('c')
        await host.notification
        expect(effects).toEqual(['authorized'])
        expect(await host.admits('bash', root)).toBe(classification === 'blocked')
        if (classification === 'framing') {
          expect(host.userMessages.at(-1)?.content).toContain(UW.target)
          expect(await host.admits('read', root)).toBe(true)
        }
      } finally {
        captured.port().cancel()
        captured.restore()
      }
    },
  )

  it.each(['#12', 'pause #12'])('clears preparing when %s finishes without confirmation', async (args) => {
    const statuses: Array<string | undefined> = []
    const host = installed({
      featureWorkflow: workflow(async () => ({ kind: 'blocked', reason: 'fixture-blocked' })),
    })
    const root = contextOf(session())
    Object.assign(root.ui, {
      setStatus: (_key: string, text: string | undefined) => {
        statuses.push(text)
      },
    })
    await host.command(args, root)
    expect(statuses.some((text) => text !== undefined)).toBe(true)
    expect(statuses.at(-1)).toBeUndefined()
    expect(operatorConfirmation.reopenOperatorConfirmation(root)).toBe('none')
  })

  it('does not send a late feature result to a new session after a held command was confirmed', async () => {
    const captured = captureCommandPort()
    const dialog = manualOperatorDialog()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const host = installed({
      featureWorkflow: workflow(async () => {
        await captured.port().executeConfirmed(confirmationProposal, async () => 'accepted')
        entered.resolve()
        await release.promise
        return { kind: 'blocked', reason: 'old-session-result' }
      }),
    })
    const state = session()
    const root = contextOf(state)
    Object.assign(root.ui, dialog.ui)
    try {
      const running = host.command('#42', root)
      const first = await dialog.nextMount()
      first.handleInput?.('\u001b')
      await running
      await host.shortcut(root)
      const reopened = await dialog.nextMount()
      reopened.handleInput?.('c')
      await entered.promise
      state.id = 'next-session'
      state.artifacts = consultableProtocolOptions()
      await host.emit('session_switch', {}, root)
      release.resolve()
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(host.messages).toEqual([])
      expect(host.userMessages).toEqual([])
    } finally {
      release.resolve()
      captured.port().cancel()
      captured.restore()
    }
  })

  it('stays read-only until classified, then settles to an ordinary operation', async () => {
    const classified = deferred<ContinueFeatureResult>()
    const entered = deferred<void>()
    const host = installed({
      featureWorkflow: workflow(async () => {
        entered.resolve()
        return classified.promise
      }),
    })
    const root = contextOf(session())

    const running = host.command('#12', root)
    expect(await host.admits('bash', root)).toBe(false)
    await entered.promise
    expect(await host.admits('bash', root)).toBe(false)
    expect(await host.admits('read', root)).toBe(true)
    classified.resolve({ kind: 'blocked', reason: 'fixture-blocked' })
    await running

    expect(await host.admits('bash', root)).toBe(true)
    expect(host.userMessages).toEqual([])
  })

  it('never begins framing from a replaced command whose classification arrives late', async () => {
    const late = deferred<ContinueFeatureResult>()
    const entered = deferred<void>()
    let calls = 0
    const host = installed({
      featureWorkflow: workflow(async () => {
        calls += 1
        if (calls > 1) return { kind: 'blocked', reason: 'fixture-blocked' }
        entered.resolve()
        return late.promise
      }),
    })
    const root = contextOf(session())

    const replaced = host.command('#12', root)
    await entered.promise
    await host.command('#13', root)
    late.resolve({
      kind: 'framing',
      source: { kind: 'issue', uw: { repository: 'acme/widgets', target: 'acme/widgets#12' } },
    })
    await replaced

    expect(host.procedureReads()).toBe(0)
    expect(host.userMessages).toEqual([])
    expect(await host.admits('bash', root)).toBe(true)
  })
})

describe('framing root lifecycle', () => {
  it('revokes on an aborted root stop and keeps denying until the session settles idle', async () => {
    const host = installed()
    const state = session()
    const root = contextOf(state)
    await interviewing(host, root, 'ship the billing export')
    state.idle = false
    const aborted = new AbortController()
    aborted.abort()

    await host.emit('session_stop', { type: 'session_stop', signal: aborted.signal }, root)

    expect(state.aborts).toBeGreaterThan(0)
    expect(await host.emit('context', contextEvent(), root)).toBeUndefined()
    expect(await host.submit({}, root, new AbortController().signal)).toMatchObject({ status: 'refused' })
    expect(await host.admits('bash', root)).toBe(false)
    expect(await host.admits('read', root)).toBe(true)

    state.idle = true
    await host.emit('agent_end', { type: 'agent_end', messages: [] }, root)

    expect(await host.admits('bash', root)).toBe(true)
  })

  it('revokes the exact lease when an ordinary root stop aborts later', async () => {
    const host = installed()
    const root = contextOf(session())
    await interviewing(host, root, 'ship the billing export')
    const stop = new AbortController()

    await host.emit('session_stop', { type: 'session_stop', signal: stop.signal }, root)
    expect(await host.emit('context', contextEvent(), root)).toBeDefined()
    stop.abort()

    expect(await host.emit('context', contextEvent(), root)).toBeUndefined()
    expect(await host.admits('bash', root)).toBe(true)
  })

  it('leaves a successor lease untouched when a replaced lease stop aborts', async () => {
    const host = installed()
    const root = contextOf(session())
    await interviewing(host, root, 'first billing subject')
    const stop = new AbortController()
    await host.emit('session_stop', { type: 'session_stop', signal: stop.signal }, root)

    await host.command('second billing subject', root)
    stop.abort()

    expect(host.userMessages.map((message) => message.content)).toEqual([
      'first billing subject',
      'second billing subject',
    ])
    expect(await host.emit('context', contextEvent(), root)).toBeDefined()
    expect(await host.admits('bash', root)).toBe(false)
  })

  it('invalidates framing on a switch to another session', async () => {
    const host = installed()
    const root = contextOf(session())
    await interviewing(host, root, 'ship the billing export')
    const other = contextOf(session('other-session'))

    await host.emit(
      'session_switch',
      { type: 'session_switch', reason: 'resume', previousSessionFile: `${CWD}/root-session.jsonl` },
      other,
    )

    expect(await host.emit('context', contextEvent(), root)).toBeUndefined()
    expect(await host.admits('bash', other)).toBe(true)
  })
})
