import { describe, expect, it } from 'vitest'
import { parseFeatureCommand } from '../../roxabi/feature-command'
import type { FeatureWorkflow } from '../../roxabi/feature-contract'
import { runInstalledFeatureCommand } from '../../roxabi/feature-entry'

function workflow(impl: Partial<FeatureWorkflow> = {}): FeatureWorkflow {
  return {
    continueFeature: async () => ({ kind: 'blocked', reason: 'unconfigured' }),
    consumeWatchExit: async () => ({ kind: 'blocked', reason: 'watch-unconfigured' }),
    publishFeatureNativeResult: async () => {
      throw new Error('unexpected-native-publication')
    },
    requestFeatureSessionPause: async () => ({ kind: 'paused', confirmed: false, reason: 'pause-unconfirmed' }),
    ...impl,
  }
}

describe('feature command grammar', () => {
  it('accepts a reference, explicit resume, and a material decision without treating resume as a second confirmation', () => {
    expect(parseFeatureCommand('#12')).toEqual({ ok: true, control: 'select', reference: '12' })
    expect(parseFeatureCommand('resume 12')).toEqual({ ok: true, control: 'resume', reference: '12' })
    expect(parseFeatureCommand('new feature-subject')).toEqual({
      ok: true,
      control: 'new',
      reference: 'feature-subject',
    })
    expect(parseFeatureCommand('material-decision #9 reject')).toEqual({
      ok: true,
      control: 'material-decision',
      reference: '9',
      decision: 'reject',
    })
    expect(parseFeatureCommand('pause')).toEqual({ ok: false, reason: 'feature-reference-missing' })
    expect(parseFeatureCommand('material-decision #9 maybe')).toEqual({
      ok: false,
      reason: 'feature-material-decision-invalid',
    })
  })
})

describe('feature init route', () => {
  it('keeps init and dry-run off framing and does not invent apply approval', async () => {
    expect(parseFeatureCommand('init')).toEqual({ ok: true, control: 'init', args: [] })
    expect(parseFeatureCommand('init --dry-run')).toEqual({ ok: true, control: 'init', args: ['--dry-run'] })
    expect(parseFeatureCommand("init --approve abc --operator-approval 'ship it'")).toEqual({
      ok: true,
      control: 'init',
      args: ['--approve', 'abc', '--operator-approval', 'ship it'],
    })
    expect(parseFeatureCommand('new init')).toEqual({ ok: true, control: 'new', reference: 'init' })
    expect(parseFeatureCommand("init --operator-approval 'unterminated")).toEqual({
      ok: false,
      reason: 'feature-init-invalid',
    })

    const calls: string[] = []
    const execs: { command: string; args: string[]; cwd?: string }[] = []
    const sent: string[] = []
    let activated = false
    const host = {
      key: {},
      cwd: '/candidate/checkout',
      principal: true,
      workflow: workflow({
        continueFeature: async () => {
          calls.push('continue')
          return { kind: 'operator-decision', reason: 'needs-framing' }
        },
      }),
      native: {
        activate: () => {
          activated = true
        },
        inactive: () => undefined,
        stopOwned: async () => undefined,
        announce: async () => undefined,
      },
      send: async (text: string) => {
        sent.push(text)
      },
      inhibitFeatureContinuation: () => undefined,
      releaseFeatureContinuation: () => undefined,
      featureContinuationInhibited: () => false,
      markFeatureBatch: () => undefined,
      git: async (args: readonly string[], cwd: string) => {
        calls.push(`git:${cwd}:${args.join(' ')}`)
        return { stdout: '/captured/target\n', exitCode: 0 }
      },
      exec: async (command: string, args: string[], options?: { cwd?: string }) => {
        calls.push('exec')
        execs.push({ command, args, cwd: options?.cwd })
        return { code: 0, killed: false, stdout: 'digest: abc\ndigest is not authorization\n' }
      },
    }

    await runInstalledFeatureCommand('init', host)
    await runInstalledFeatureCommand('init --dry-run', host)
    await runInstalledFeatureCommand("init --approve abc --operator-approval 'ship it'", host)

    expect(calls.filter((call) => call === 'continue')).toEqual([])
    expect(activated).toBe(false)
    expect(calls.indexOf('git:/candidate/checkout:rev-parse --show-toplevel')).toBeLessThan(calls.indexOf('exec'))
    expect(execs).toHaveLength(3)
    for (const exec of execs) {
      expect(exec.command).toBe('bun')
      expect(exec.cwd).toMatch(/\/skills\/feature$/)
      expect(exec.cwd).not.toBe('/candidate/checkout')
      expect(exec.args[0]).toBe('--no-env-file')
      expect(exec.args[1]).toMatch(/\/skills\/feature\/feature-init\.ts$/)
      expect(exec.args.slice(2, 4)).toEqual(['--dir', '/captured/target'])
    }
    expect(execs[0]?.args.slice(4)).toEqual([])
    expect(execs[1]?.args.slice(4)).toEqual(['--dry-run'])
    expect(execs[2]?.args.slice(4)).toEqual(['--approve', 'abc', '--operator-approval', 'ship it'])
    expect(execs[0]?.args).not.toContain('--approve')
    expect(execs[1]?.args).not.toContain('--approve')
    expect(sent).toEqual([
      'digest: abc\ndigest is not authorization\n',
      'digest: abc\ndigest is not authorization\n',
      'digest: abc\ndigest is not authorization\n',
    ])
  })

  it('does not launch init or framing when the target capture fails', async () => {
    let executed = false
    let continued = false
    const sent: string[] = []
    await runInstalledFeatureCommand('init --dry-run', {
      key: {},
      cwd: '/candidate/checkout',
      principal: false,
      workflow: workflow({
        continueFeature: async () => {
          continued = true
          return { kind: 'blocked', reason: 'unconfigured' }
        },
      }),
      native: {
        activate: () => undefined,
        inactive: () => undefined,
        stopOwned: async () => undefined,
        announce: async () => undefined,
      },
      send: async (text: string) => {
        sent.push(text)
      },
      inhibitFeatureContinuation: () => undefined,
      releaseFeatureContinuation: () => undefined,
      featureContinuationInhibited: () => false,
      markFeatureBatch: () => undefined,
      git: async () => ({ stdout: '', exitCode: 1 }),
      exec: async () => {
        executed = true
        return { code: 0, killed: false, stdout: '', stderr: '' }
      },
    })
    expect(executed).toBe(false)
    expect(continued).toBe(false)
    expect(sent).toEqual(['feature-stopped: feature-init-target-unobserved'])
  })
})
