import type { ContextEvent } from '@oh-my-pi/pi-coding-agent'
import { expect } from 'vitest'
import type { FramingSourceRequest } from '../feature-framing-contract.ts'
import { ARGS, questionEntry, userEntry, type World } from './feature-framing-controller-world.ts'

let sequence = 0
export async function supplyToken(w: World, ctx = w.ctx()): Promise<string> {
  const projected = await w.controller.project({ type: 'context', messages: [] } as unknown as ContextEvent, ctx)
  const last = projected?.messages?.at(-1)
  const content = last && 'content' in last ? String(last.content) : ''
  const match = /^Supply token: (\S+)$/m.exec(content)
  if (!match?.[1]) throw new Error('framing projection is missing')
  return match[1]
}

export async function submit(w: World, form: unknown, toolCallId = `call-${++sequence}`) {
  return w.controller.submit(
    { supplyToken: await supplyToken(w), form },
    { ctx: w.ctx(), toolCallId, signal: new AbortController().signal },
  )
}

export const codes = (result: { diagnostics: readonly { code: string }[] }) =>
  result.diagnostics.map((item) => item.code)

export async function begun(w: World, source: FramingSourceRequest = { kind: 'free-text', acceptedArgs: ARGS }) {
  const lease = w.controller.begin(source, w.ctx())
  await w.controller.start(lease)
  return lease
}

export async function answeredQuestion(w: World, entry: string) {
  const call = `call-${entry}`
  expect((await submit(w, { kind: 'question', question: `Question ${entry}?` }, call)).status).toBe('waiting')
  w.entries.push(questionEntry(`q-${entry}`, call), userEntry(`u-${entry}`, `Answer ${entry}`))
  return { questionEntryId: `q-${entry}`, answerEntryId: `u-${entry}`, decision: `Decision ${entry}` }
}

export async function leafInterview(w: World) {
  await begun(w)
  const decision = await answeredQuestion(w, 'grill')
  const grilling = await submit(w, {
    kind: 'grilling',
    shape: 'leaf',
    unresolved: [],
    decisions: [decision],
    terms: [{ term: 'queue', meaning: 'FIFO request buffer' }],
  })
  expect(grilling.status).toBe('accepted')
}

const sections = { origin: 'Origin', context: 'Context', change: 'Change' }
export function leafProposal(
  vocabulary: unknown[] = [
    {
      term: 'queue',
      invariant: { kind: 'new', draftKey: 'queue-term' },
      criterion: { kind: 'new', draftKey: 'glossary' },
    },
  ],
) {
  return {
    kind: 'proposal',
    decisions: [],
    modules: [],
    vocabulary,
    aggregate: {
      kind: 'uw',
      root: 'root',
      edges: [],
      coverage: [],
      foundations: [],
      members: [
        {
          kind: 'uw',
          slot: { kind: 'new', key: 'root' },
          title: 'Request queue',
          draft: {
            criteria: [{ kind: 'new', draftKey: 'glossary', statement: 'The glossary defines queue' }],
            invariants: [{ kind: 'new', draftKey: 'queue-term', statement: 'A queue is a FIFO request buffer' }],
            exclusions: [],
            openQuestions: [],
            sections,
          },
          factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
          tierOverride: null,
          labels: { add: [], remove: [] },
          merges: [],
          normalization: [
            {
              origin: null,
              decision: {
                kind: 'new',
                target: { kind: 'new', draftKey: 'glossary' },
                reason: 'Operator chose the term',
              },
            },
            {
              origin: null,
              decision: {
                kind: 'new',
                target: { kind: 'new', draftKey: 'queue-term' },
                reason: 'Operator chose the term',
              },
            },
            ...(['origin', 'context', 'change'] as const).map((section) => ({
              origin: null,
              decision: {
                kind: 'new',
                target: { kind: 'section', section, range: { start: 0, end: sections[section].length } },
                reason: 'Interview context',
              },
            })),
          ],
        },
      ],
    },
  }
}
