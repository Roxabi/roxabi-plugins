import { describe, expect, it } from 'vitest'
import { parseFeatureCommand } from '../feature-command.ts'

describe('explicit interruption resolution command', () => {
  it.each([
    ['resolve-interruption #42', { ok: true, control: 'resolve-interruption', reference: '42' }],
    ['resolve-interruption 42', { ok: true, control: 'resolve-interruption', reference: '42' }],
    ['  resolve-interruption   #42  ', { ok: true, control: 'resolve-interruption', reference: '42' }],
    [
      'resolve-interruption #42 --start act-plan-1-start',
      { ok: true, control: 'resolve-interruption', reference: '42', start: 'act-plan-1-start' },
    ],
  ])('parses %j', (args, expected) => {
    expect(parseFeatureCommand(args)).toEqual(expected)
  })

  it.each([
    'resolve-interruption',
    'resolve-interruption #',
    'resolve-interruption #42 extra',
    'resolve-interruption #42 --start',
    'resolve-interruption #42 --start a b',
    'resolve-interruption --start act-plan-1-start #42',
    'resolve-interruption #42 --begin act-plan-1-start',
    'resolve-interruption #pause',
    'resolve-interruption #resolve-interruption',
  ])('refuses %j instead of treating it as free text or selection', (args) => {
    expect(parseFeatureCommand(args)).toEqual({ ok: false, reason: 'feature-interruption-invalid' })
  })

  it('reserves the control word as a reference', () => {
    expect(parseFeatureCommand('#resolve-interruption')).toEqual({ ok: false, reason: 'feature-reference-invalid' })
  })

  it('leaves the existing pause and abandon controls unchanged', () => {
    expect(parseFeatureCommand('pause #42')).toEqual({ ok: true, control: 'pause', reference: '42' })
    expect(parseFeatureCommand('abandon #42')).toEqual({ ok: true, control: 'abandon', reference: '42' })
  })
})
