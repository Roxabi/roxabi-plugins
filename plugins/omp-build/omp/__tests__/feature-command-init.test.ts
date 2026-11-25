import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseFeatureCommand } from '../../roxabi/feature-command'
import { createExtensionApiStub } from '../../testing/extension-api-stub'
import ompBuildExtension from '../index'
import type { OmpBuildExtensionApi } from '../omp-controller'
import { featureCommandContext } from './feature-command-fixture.ts'

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const { promisify } = await import('node:util')
  const execFile = async (_command: string, _args: string[], options: { cwd: string }) => {
    if (options.cwd.endsWith('/missing-checkout')) throw new Error('not a repository')
    return { stdout: options.cwd, stderr: '' }
  }
  return { ...original, execFile: Object.assign(execFile, { [promisify.custom]: execFile }) }
})

const paths: string[] = []
afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})

function installed(cwd: string, exec: OmpBuildExtensionApi['exec']) {
  const context = featureCommandContext(cwd)
  const sent: string[] = []
  const continueFeature = vi.fn(async () => ({ kind: 'blocked', reason: 'unexpected-continuation' }) as const)
  let handler: ((args: string) => Promise<void>) | undefined
  const api = createExtensionApiStub({
    exec,
    registerCommand: (name, command) => {
      if (name === 'feature') handler = (args) => command.handler(args, context as never)
    },
    sendUserMessage: async (content) => {
      sent.push(String(content))
    },
    sendMessage: (message) => {
      sent.push(typeof message === 'string' ? message : String(message?.content ?? message))
    },
  })
  ompBuildExtension(api, { principalCwd: () => true, featureWorkflow: { continueFeature } })
  if (handler === undefined) throw new Error('missing installed /feature')
  return { run: handler, sent, continueFeature }
}

function directory() {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'omp-feature-init-')))
  paths.push(path)
  return path
}

describe('feature command grammar', () => {
  it('accepts existing references and retained controls without argv authority', () => {
    expect(parseFeatureCommand('#12')).toEqual({ ok: true, control: 'select', reference: '12' })
    expect(parseFeatureCommand('pause #12')).toEqual({ ok: true, control: 'pause', reference: '12' })
    expect(parseFeatureCommand('abandon #12')).toEqual({ ok: true, control: 'abandon', reference: '12' })
    expect(parseFeatureCommand('new feature-subject')).toEqual({
      ok: true,
      control: 'new',
      reference: 'feature-subject',
    })
    expect(parseFeatureCommand('material-decision #9')).toEqual({
      ok: true,
      control: 'material-decision',
      reference: '9',
    })
    expect(parseFeatureCommand('pause')).toEqual({ ok: false, reason: 'feature-reference-missing' })
    expect(parseFeatureCommand('material-decision #9 accept')).toEqual({
      ok: false,
      reason: 'feature-material-decision-invalid',
    })
  })

  it.each(['resume', 'resolve-interruption'])('rejects retired control %s instead of selecting it', (control) => {
    expect(parseFeatureCommand(control)).toEqual({ ok: false, reason: 'feature-control-retired' })
    expect(parseFeatureCommand(`${control} #12`)).toEqual({ ok: false, reason: 'feature-control-retired' })
    expect(parseFeatureCommand(`#${control}`)).toEqual({ ok: true, control: 'select', reference: control })
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

    const target = directory()
    const execs: { command: string; args: readonly string[]; cwd: string | undefined }[] = []
    const host = installed(target, async (command, args, options) => {
      execs.push({ command, args, cwd: options?.cwd })
      return { code: 0, killed: false, stdout: 'digest: abc\ndigest is not authorization\n', stderr: '' }
    })

    await host.run('init')
    await host.run('init --dry-run')
    await host.run("init --approve abc --operator-approval 'ship it'")

    expect(host.continueFeature).not.toHaveBeenCalled()
    expect(execs).toHaveLength(3)
    for (const exec of execs) {
      expect(exec.command).toBe('bun')
      expect(exec.cwd).toMatch(/\/skills\/feature$/)
      expect(exec.cwd).not.toBe(target)
      expect(exec.args[0]).toBe('--no-env-file')
      expect(exec.args[1]).toMatch(/\/skills\/feature\/feature-init\.ts$/)
      expect(exec.args.slice(2, 4)).toEqual(['--dir', target])
    }
    expect(execs[0]?.args.slice(4)).toEqual([])
    expect(execs[1]?.args.slice(4)).toEqual(['--dry-run'])
    expect(execs[2]?.args.slice(4)).toEqual(['--approve', 'abc', '--operator-approval', 'ship it'])
    expect(execs[0]?.args).not.toContain('--approve')
    expect(execs[1]?.args).not.toContain('--approve')
    expect(host.sent).toEqual([
      'digest: abc\ndigest is not authorization\n',
      'digest: abc\ndigest is not authorization\n',
      'digest: abc\ndigest is not authorization\n',
    ])
  })

  it('does not launch init or framing when the target capture fails', async () => {
    const exec = vi.fn(async () => ({ code: 0, killed: false, stdout: '', stderr: '' }))
    const host = installed(join(directory(), 'missing-checkout'), exec)
    await host.run('init --dry-run')
    expect(exec).not.toHaveBeenCalled()
    expect(host.continueFeature).not.toHaveBeenCalled()
    expect(host.sent).toEqual(['feature-stopped: feature-init-target-unobserved'])
  })
})
