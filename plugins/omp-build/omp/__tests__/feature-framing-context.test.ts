import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { framingFormSchema } from '../../engine/framing-form-schema.ts'
import {
  captureFramingMaterial,
  framingReferenceInText,
  validateFramingDecisionReferences,
} from '../../roxabi/feature-framing-source.ts'

describe('operator-selected framing references', () => {
  it('binds only delimited issue tokens actually present in the operator text', () => {
    expect(framingReferenceInText('build X per #3', '#3')).toBe(true)
    expect(framingReferenceInText('use (owner/repo#19).', 'owner/repo#19')).toBe(true)
    expect(framingReferenceInText('split into 3 slices', '3')).toBe(false)
    expect(framingReferenceInText('build #30', '#3')).toBe(false)
    expect(framingReferenceInText('build X', '#3')).toBe(false)
    expect(framingReferenceInText('build X per x#3', '#3')).toBe(false)
  })
})

describe('framing input admission', () => {
  it('accepts an operator-entry selection but rejects native material and model Scope', () => {
    expect(framingFormSchema.safeParse({ kind: 'material', producer: 'to-spec', entry: 'entry-1' }).success).toBe(true)
    expect(
      framingFormSchema.safeParse({ kind: 'material', producer: 'to-spec', entry: 'entry-1', issue: '#3' }).success,
    ).toBe(false)
    expect(
      framingFormSchema.safeParse({
        kind: 'select-existing',
        text: 'accepted-args',
        reference: '#3',
        uw: { repository: 'a/b', target: '#3' },
      }).success,
    ).toBe(false)
  })
})

describe('framing material provenance', () => {
  it('captures exact current-branch USER text and rejects assistant and multipart entries', () => {
    const branch = [
      { id: 'user', type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'Exact\nrequest' }] } },
      { id: 'assistant', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'echo' }] } },
      {
        id: 'multi',
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'one' },
            { type: 'text', text: 'two' },
          ],
        },
      },
      { id: 'agent-user', type: 'message', message: { role: 'user', attribution: 'agent', content: 'injected' } },
      { id: 'synthetic', type: 'message', message: { role: 'user', synthetic: true, content: 'continue' } },
    ]
    const ctx = {
      sessionManager: { getBranch: () => branch, getSessionId: () => 'session' },
    } as unknown as ExtensionContext
    const captured = captureFramingMaterial(ctx, 'm1', 'to-spec', 'user')
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    expect(captured.value.raw.reference).toBe('omp-session-entry:session/user')
    expect(captured.value.raw.body).toBe('Exact\nrequest')
    expect(captureFramingMaterial(ctx, 'm2', 'to-spec', 'assistant').ok).toBe(false)
    expect(captureFramingMaterial(ctx, 'm3', 'to-tickets', 'multi').ok).toBe(false)
    expect(captureFramingMaterial(ctx, 'm4', 'to-spec', 'off-branch').ok).toBe(false)
    expect(captureFramingMaterial(ctx, 'm5', 'to-spec', 'agent-user').ok).toBe(false)
    expect(captureFramingMaterial(ctx, 'm6', 'to-spec', 'synthetic').ok).toBe(false)
  })
  it('requires a registered assistant question followed by an operator-authored answer', () => {
    const branch = [
      { id: 'question', type: 'message', message: { role: 'assistant', content: 'Which boundary?' } },
      { id: 'agent-answer', type: 'message', message: { role: 'user', attribution: 'agent', content: 'internal' } },
      { id: 'answer', type: 'message', message: { role: 'user', attribution: 'user', content: 'external' } },
    ]
    const ctx = { sessionManager: { getBranch: () => branch } } as unknown as ExtensionContext
    const refs = [{ questionEntryId: 'question', answerEntryId: 'answer' }]
    expect(validateFramingDecisionReferences(ctx, refs, new Set(['question'])).ok).toBe(true)
    expect(validateFramingDecisionReferences(ctx, refs, new Set()).ok).toBe(false)
    expect(
      validateFramingDecisionReferences(
        ctx,
        [{ questionEntryId: 'question', answerEntryId: 'agent-answer' }],
        new Set(['question']),
      ).ok,
    ).toBe(false)
  })
})
