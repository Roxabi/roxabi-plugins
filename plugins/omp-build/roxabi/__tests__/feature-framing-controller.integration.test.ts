import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContextEvent } from '@oh-my-pi/pi-coding-agent'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { resolveSpecIdentityLedger } from '../../engine/uw-identity.ts'
import { localProtocolRoot } from '../../omp/action-communication.ts'
import { dispose } from '../../skills/feature/testing/goal/goal-scenario-sandbox.ts'
import { UW } from '../../testing/uw-operations-fixture.ts'
import { readFixtureUw } from '../../testing/uw-operations-fixture-read.ts'
import {
  answeredQuestion,
  begun,
  codes,
  leafInterview,
  leafProposal,
  submit,
  supplyToken,
} from './feature-framing-controller-drivers.ts'
import { ARGS, questionEntry, userEntry, type World, world } from './feature-framing-controller-world.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  dispose()
})

function retainedIndex(w: World): Record<string, unknown> {
  const reference = w.controller.view()?.indexRef
  const root = localProtocolRoot(w.ctx())
  if (!reference || root === null) throw new Error('framing index is not retained')
  return JSON.parse(readFileSync(join(root, reference.slice('local://'.length)), 'utf8'))
}

describe('root framing controller', () => {
  test('begin arms the gate synchronously; start sends the exact accepted text and each projection mints a fresh token', async () => {
    const w = world()
    const lease = w.controller.begin({ kind: 'free-text', acceptedArgs: ARGS }, w.ctx())
    expect(w.controller.view()?.phase).toEqual({ kind: 'loading' })
    expect(w.controller.governs(w.ctx())).toBe(true)
    expect(w.controller.governs(w.ctx({ agent: { kind: 'sub', depth: 1, id: '0-Task', name: 'task' } }))).toBe(false)
    await w.controller.start(lease)
    expect(w.sent).toEqual([{ content: ARGS, options: { attribution: 'user' } }])
    expect(w.controller.view()?.phase).toEqual({ kind: 'interview', stage: 'grilling', waitingQuestion: null })
    const first = await supplyToken(w)
    const second = await supplyToken(w)
    expect(second).not.toBe(first)
    const actual = { ctx: w.ctx(), toolCallId: 'call-stale', signal: new AbortController().signal }
    const stale = await w.controller.submit(
      { supplyToken: first, form: { kind: 'question', question: 'Which queue?' } },
      actual,
    )
    expect(codes(stale)).toEqual(['framing-supply-token-stale'])
    const fresh = await w.controller.submit(
      { supplyToken: second, form: { kind: 'question', question: 'Which queue?' } },
      actual,
    )
    expect(fresh.status).toBe('waiting')
  })

  test('a subagent gets no projection and cannot submit', async () => {
    const w = world()
    await begun(w)
    const sub = w.ctx({ agent: { kind: 'sub', depth: 1, id: '0-Task', name: 'task', parentId: 'Main' } })
    expect(
      await w.controller.project({ type: 'context', messages: [] } as unknown as ContextEvent, sub),
    ).toBeUndefined()
    const refused = await w.controller.submit(
      { supplyToken: await supplyToken(w), form: { kind: 'question', question: 'Q?' } },
      { ctx: sub, toolCallId: 'call-sub', signal: new AbortController().signal },
    )
    expect(codes(refused)).toEqual(['framing-root-required'])
  })

  test('a registered question waits for a genuine operator answer, not an agent or synthetic echo', async () => {
    const w = world()
    await begun(w)
    expect((await submit(w, { kind: 'question', question: 'FIFO or priority?' }, 'call-q1')).status).toBe('waiting')
    w.entries.push(questionEntry('q1', 'call-q1'))
    const grilling = (answer: string) => ({
      kind: 'grilling',
      shape: 'leaf',
      unresolved: [],
      terms: [{ term: 'queue', meaning: 'FIFO buffer' }],
      decisions: [{ questionEntryId: 'q1', answerEntryId: answer, decision: 'FIFO' }],
    })
    expect(codes(await submit(w, grilling('q1')))).toEqual(['framing-answer-pending'])
    w.entries.push(
      userEntry('echo', 'FIFO', { attribution: 'agent' }),
      userEntry('synthetic', 'FIFO', { synthetic: true }),
    )
    expect(codes(await submit(w, grilling('echo')))).toEqual(['framing-answer-pending'])
    w.entries.push(userEntry('u1', 'FIFO please'))
    expect((await submit(w, grilling('echo'))).status).toBe('refused')
    expect((await submit(w, grilling('u1'))).status).toBe('accepted')
    const index = retainedIndex(w)
    expect(index.operatorEntries).toEqual([{ entryId: 'u1', text: 'FIFO please' }])
    expect(index.questions).toEqual([
      expect.objectContaining({ toolCallId: 'call-q1', entryId: 'q1', stage: 'grilling' }),
    ])
  })

  test('a Parent cannot skip domain modeling or codebase design, and each stage needs its own question', async () => {
    const w = world()
    await begun(w)
    const decision = await answeredQuestion(w, 'grill')
    expect(
      (await submit(w, { kind: 'grilling', shape: 'parent', unresolved: [], decisions: [decision], terms: [] })).status,
    ).toBe('accepted')
    expect(w.controller.view()?.phase).toEqual({ kind: 'interview', stage: 'domain-modeling', waitingQuestion: null })
    expect(
      codes(await submit(w, { kind: 'module-design', unresolved: [], decisions: [decision], modules: [] })),
    ).toEqual(['framing-stage-order'])
    expect(codes(await submit(w, leafProposal([])))).toEqual(['framing-stage-incomplete'])
    expect(codes(await submit(w, { kind: 'terminology', unresolved: [], decisions: [decision], terms: [] }))).toEqual([
      'framing-stage-decision-missing',
    ])
    const domain = await answeredQuestion(w, 'domain')
    expect(
      (
        await submit(w, {
          kind: 'terminology',
          unresolved: [],
          decisions: [domain],
          terms: [{ term: 'lane', meaning: 'ordered stream' }],
        })
      ).status,
    ).toBe('accepted')
    expect(w.controller.view()?.phase).toEqual({ kind: 'interview', stage: 'codebase-design', waitingQuestion: null })
  })

  test('procedure supply drift blocks the interview and aborts the root turn', async () => {
    const w = world()
    await begun(w)
    w.supply.drift('grilling')
    expect(
      await w.controller.project({ type: 'context', messages: [] } as unknown as ContextEvent, w.ctx()),
    ).toBeUndefined()
    expect(w.controller.view()?.phase).toEqual({ kind: 'blocked', reason: 'framing-supply-changed' })
    expect(w.runtime.aborts).toBeGreaterThan(0)
  })

  test('a location change revokes; cancellation keeps denying until idle; explicit replacement releases at once', async () => {
    const moved = world()
    await begun(moved)
    moved.location.cwd = '/work/elsewhere'
    expect(
      await moved.controller.project({ type: 'context', messages: [] } as unknown as ContextEvent, moved.ctx()),
    ).toBeUndefined()
    expect(moved.controller.view()?.revoked).toBe(true)

    const cancelled = world()
    await begun(cancelled)
    cancelled.controller.cancel('session-switch')
    expect(cancelled.controller.view()).toEqual(
      expect.objectContaining({ revoked: true, phase: { kind: 'closed', reason: 'session-switch' } }),
    )
    expect(cancelled.controller.governs(cancelled.ctx())).toBe(true)
    cancelled.runtime.idle = true
    expect(cancelled.controller.view()).toBeNull()

    const replaced = world()
    await begun(replaced)
    replaced.replaceOwner()
    expect(replaced.controller.view()).toBeNull()
  })

  test('a replacement begin revokes the former lease and its handle can no longer start', async () => {
    const w = world()
    const former = w.controller.begin({ kind: 'free-text', acceptedArgs: ARGS }, w.ctx())
    const next = w.controller.begin({ kind: 'free-text', acceptedArgs: 'Another request' }, w.ctx())
    await w.controller.start(former)
    expect(w.sent).toEqual([])
    await w.controller.start(next)
    expect(w.sent).toEqual([{ content: 'Another request', options: { attribution: 'user' } }])
    expect(w.controller.view()?.generation).toBe(2)
  })

  test('answer-only closes with “pas d’UW” and zero UW effects', async () => {
    const w = world()
    await begun(w)
    const answered = await submit(w, { kind: 'answer-only', answer: 'Queues are FIFO buffers.' })
    expect(codes(answered)).toEqual(['framing-answer-only'])
    expect(w.statuses.at(-1)).toContain('pas d’UW')
    expect(w.uw.state.patchCount).toBe(0)
    expect(w.uw.state.identityScopes).toEqual([])
    w.runtime.idle = true
    expect(w.controller.view()).toBeNull()
  })

  test('material captures only genuine operator entries and never a native issue; reselection mints a new id', async () => {
    const w = world()
    await begun(w)
    w.entries.push(questionEntry('assistant-spec', 'call-other'), userEntry('spec', 'Spec: requests are retried'))
    expect(codes(await submit(w, { kind: 'material', producer: 'to-spec', entry: 'spec', issue: '#3' }))).toEqual([
      'framing-material-native-issue',
    ])
    expect((await submit(w, { kind: 'material', producer: 'to-spec', entry: 'assistant-spec' })).status).toBe('refused')
    expect(
      (await submit(w, { kind: 'material', producer: 'to-spec', entry: 'spec' })).diagnostics[0]?.message,
    ).toContain('m1')
    expect(
      (await submit(w, { kind: 'material', producer: 'to-spec', entry: 'spec' })).diagnostics[0]?.message,
    ).toContain('m2')
    expect(retainedIndex(w).materials).toEqual([
      expect.objectContaining({ id: 'm2', entryId: 'spec', body: 'Spec: requests are retried' }),
    ])
  })

  test('a Leaf proposal must bind its vocabulary to root obligations and is staged without any UI', async () => {
    const w = world()
    await leafInterview(w)
    expect(codes(await submit(w, leafProposal([])))).toEqual(['framing-vocabulary-unbound'])
    const staged = await submit(w, leafProposal())
    expect(codes(staged)).toEqual(['framing-proposal-staged'])
    expect(w.controller.view()?.phase.kind).toBe('proposal-ready')
    expect(w.runtime.confirms).toBe(0)
    expect(w.uw.state.patchCount).toBe(0)
  })

  test('a vocabulary-free Leaf stages without vocabulary obligations', async () => {
    const w = world()
    await begun(w)
    const decision = await answeredQuestion(w, 'grill-free')
    expect(
      (
        await submit(w, {
          kind: 'grilling',
          shape: 'leaf',
          unresolved: [],
          decisions: [decision],
          terms: [],
        })
      ).status,
    ).toBe('accepted')
    const proposal = leafProposal([])
    const draft = proposal.aggregate.members[0]
    draft.draft.criteria = [{ kind: 'new', draftKey: 'glossary', statement: 'The request is processed' }]
    draft.draft.invariants = []
    draft.normalization = draft.normalization.filter(
      (item) => !('draftKey' in item.decision.target && item.decision.target.draftKey === 'queue-term'),
    )
    expect(codes(await submit(w, proposal))).toEqual(['framing-proposal-staged'])
    expect(w.controller.view()?.phase.kind).toBe('proposal-ready')
    expect(w.runtime.confirms).toBe(0)
    expect(w.uw.state.patchCount).toBe(0)
  })

  test('a Wayfinder proposal needs an answered Wayfinder offer', async () => {
    const w = world()
    await begun(w)
    const wayfinder = {
      kind: 'proposal',
      decisions: [],
      vocabulary: [],
      modules: [],
      aggregate: {
        kind: 'wayfinder',
        root: 'map',
        edges: [],
        coverage: [],
        foundations: [],
        members: [
          {
            kind: 'wayfinder',
            slot: { kind: 'new', key: 'map' },
            title: 'Map the queue',
            body: 'Explore',
            label: 'wayfinder:map',
          },
        ],
      },
    }
    expect(codes(await submit(w, wayfinder))).toEqual(['framing-wayfinder-choice-missing'])
  })

  test('the shortcut needs the idle root TUI; a declined confirmation returns to the interview with zero effects', async () => {
    const w = world({ publication: true })
    await leafInterview(w)
    expect(codes(await submit(w, leafProposal()))).toEqual(['framing-proposal-staged'])
    await w.controller.act(w.ctx())
    expect(w.controller.view()?.phase.kind).toBe('proposal-ready')
    w.runtime.idle = true
    await w.controller.act(w.ctx({ hasUI: false }))
    await w.controller.act(w.ctx({ agent: { kind: 'sub', depth: 1, id: '0-Task', name: 'task' } }))
    expect(w.controller.view()?.phase.kind).toBe('proposal-ready')
    expect(w.runtime.confirms).toBe(0)
    await w.controller.act(w.ctx())
    expect(w.runtime.confirms).toBe(1)
    expect(w.statuses.at(-1)).toContain('operator-confirmation-declined')
    expect(w.controller.view()?.phase.kind).toBe('interview')
    expect(w.controller.view()?.pendingMove).toBeNull()
    expect(w.uw.state.patchCount).toBe(0)
    expect(w.uw.state.identityScopes).toEqual([])
  })

  test('close without a decision keeps the exact proposal ready to reopen', async () => {
    const w = world({ publication: true })
    await leafInterview(w)
    expect(codes(await submit(w, leafProposal()))).toEqual(['framing-proposal-staged'])
    const ready = w.controller.view()?.phase
    w.runtime.choices.push('defer', 'defer')
    w.runtime.idle = true
    await w.controller.act(w.ctx())
    expect(w.controller.view()?.phase).toEqual(ready)
    expect(w.uw.state.patchCount).toBe(0)
    expect(w.uw.state.identityScopes).toEqual([])
    await w.controller.act(w.ctx())
    expect(w.runtime.confirms).toBe(2)
    expect(w.controller.view()?.phase).toEqual(ready)
    expect(w.uw.state.patchCount).toBe(0)
    expect(w.uw.state.identityScopes).toEqual([])
  })

  test('revoking the session after defer prevents reopening and effects', async () => {
    const w = world({ publication: true })
    await leafInterview(w)
    expect(codes(await submit(w, leafProposal()))).toEqual(['framing-proposal-staged'])
    w.runtime.idle = true
    w.runtime.choices.push('defer', 'confirm')
    await w.controller.act(w.ctx())
    w.controller.cancel('session-switch')
    await w.controller.act(w.ctx())
    expect(w.runtime.confirms).toBe(1)
    expect(w.uw.state.patchCount).toBe(0)
    expect(w.uw.state.identityScopes).toEqual([])
  })

  test('an issue source is continued as agent-attributed data and its drift blocks the next transition', async () => {
    const w = world()
    w.uw.state.body = ''
    const read = readFixtureUw(w.uw.state)
    const ledger = resolveSpecIdentityLedger({
      uw: UW,
      history: read.histories[0],
      histories: read.histories,
      accepted: null,
    })
    if (!ledger.ok) throw new Error('fixture identity ledger is unavailable')
    w.uw.state.ledger = ledger.value
    await begun(w, { kind: 'issue', uw: UW })
    expect(w.sent).toEqual([
      { content: expect.stringContaining(`Frame ${UW.target}`), options: { attribution: 'agent' } },
    ])
    w.uw.state.body = 'New work appeared after the original source capture'
    expect((await submit(w, { kind: 'question', question: 'Still the same scope?' })).status).toBe('refused')
    expect(w.controller.view()?.phase).toEqual({ kind: 'blocked', reason: 'framing-source-changed' })
  })
})
