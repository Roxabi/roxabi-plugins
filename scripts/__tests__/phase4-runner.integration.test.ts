import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Phase4Fixture, type Phase4Programme, runPhase4Model } from '../phase4-model'

const ROOT = resolve(import.meta.dirname, '../..')
const dirs: string[] = []

const fixture: Phase4Fixture = { id: 'transport-fixture', snapshot: 'synthetic reports' }

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function programme(): Phase4Programme {
  const source = (path: Phase4Programme['sources'][number]['path'], text: string) => ({
    path,
    bytes: new TextEncoder().encode(text),
    text,
    gitBlob: '0'.repeat(40),
    sourceSHA: digest(text),
  })
  return {
    root: ROOT,
    commitSHA: '1'.repeat(40),
    sources: [
      source('plugins/omp-build/skills/dev-review/SKILL.md', 'skill'),
      source('plugins/omp-build/skills/dev-review/root-causes.md', 'causes'),
      source('plugins/omp-build/skills/dev-review/review-smells.md', 'smells'),
      source('plugins/omp-build/skills/dev-review/review-classes.yml', 'classes'),
    ],
  }
}

function stubEnvironment(mode: string, log?: string): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), 'phase4-model-bin-'))
  dirs.push(bin)
  const executable = join(bin, 'omp')
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
if (args[0] === '--version') process.stdout.write('omp/18.12.2\\n')
else {
  if (process.env.PHASE4_STUB_LOG) writeFileSync(process.env.PHASE4_STUB_LOG, JSON.stringify({ args }))
  if (process.env.PHASE4_STUB_MODE === 'error') process.exitCode = 2
  else if (process.env.PHASE4_STUB_MODE === 'partial') process.stdout.write(JSON.stringify({ type: 'session' }) + '\\n')
  else if (process.env.PHASE4_STUB_MODE === 'hang') {
    const child = spawn(process.execPath, ['-e', "const { writeFileSync } = require('node:fs')\\nprocess.on('SIGTERM', () => { writeFileSync(process.env.PHASE4_STUB_LOG, JSON.stringify({ child: process.pid, terminated: true }))\\nprocess.exit(0) })\\nwriteFileSync(process.env.PHASE4_STUB_READY, '')\\nsetInterval(() => {}, 1_000)"], { stdio: 'ignore' })
    while (!existsSync(process.env.PHASE4_STUB_READY)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
    if (process.env.PHASE4_STUB_LOG) writeFileSync(process.env.PHASE4_STUB_LOG, JSON.stringify({ child: child.pid }))
  } else {
    const attachment = args.find((arg) => arg.startsWith('@'))
    const input = readFileSync(attachment.slice(1), 'utf8')
    let child
    if (process.env.PHASE4_STUB_MODE === 'leaky-success') {
      child = spawn(process.execPath, ['-e', "const { writeFileSync } = require('node:fs')\\nprocess.on('SIGTERM', () => {})\\nwriteFileSync(process.env.PHASE4_STUB_READY, '')\\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], { stdio: ['ignore', 'inherit', 'ignore'] })
      while (!existsSync(process.env.PHASE4_STUB_READY)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
      child.unref()
    }
    if (process.env.PHASE4_STUB_LOG) {
      writeFileSync(process.env.PHASE4_STUB_LOG, JSON.stringify({ args, config: readFileSync(args[args.indexOf('--config') + 1], 'utf8'), child: child?.pid }))
    }
    const model = process.env.PHASE4_STUB_MODE === 'wrong-model' ? 'other' : 'gpt-6.1-sol'
    const user = { role: 'user', content: [{ type: 'text', text: '<file>\\n' + input + '\\n</file>' }] }
    const assistant = { role: 'assistant', provider: 'openai-codex', model, stopReason: 'stop', content: [{ type: 'text', text: '<!-- omp-build:code-review -->\\n**Verdict: Request changes**' }] }
    const terminal = process.env.PHASE4_STUB_MODE === 'terminal-continue'
      ? { type: 'agent_end', yielded: false, messages: [] }
      : process.env.PHASE4_STUB_MODE === 'terminal-pending'
        ? { type: 'agent_end', awaitingAsyncWork: true, messages: [] }
        : process.env.PHASE4_STUB_MODE === 'terminal-nonterminal'
          ? { type: 'agent_end', isTerminal: false, messages: [] }
          : process.env.PHASE4_STUB_MODE === 'terminal-compatible'
            ? { type: 'agent_end', messages: [] }
            : { type: 'agent_end', yielded: true, messages: [] }
    const events = [
      { type: 'session', version: 3 },
      { type: 'agent_start' },
      { type: 'turn_start' },
      { type: 'message_end', message: user },
      { type: 'message_end', message: assistant },
      { type: 'turn_end', message: assistant, toolResults: [] },
      terminal,
      { type: 'lifecycle_end' },
    ]
    process.stdout.write(events.map((event) => JSON.stringify(event)).join('\\n') + '\\n')
  }
}
`,
    { mode: 0o755 },
  )
  return {
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    PHASE4_STUB_MODE: mode,
    PHASE4_STUB_LOG: log,
    PHASE4_STUB_READY: mode === 'leaky-success' || mode === 'hang' ? join(bin, 'ready') : undefined,
  }
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('runPhase4Model native transport', () => {
  it('refuses non-POSIX hosts before starting native work', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'phase4-model-platform-')), 'started.json')
    dirs.push(resolve(log, '..'))
    const env = stubEnvironment('success', log)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platform) throw new Error('Node platform descriptor is unavailable')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      await expect(runPhase4Model(programme(), fixture, { env, deadlineMs: 1_000 })).rejects.toThrow(
        'requires POSIX process-group cleanup',
      )
      expect(existsSync(log)).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('records the fixed model and removes owned input/config files after a complete native stream', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'phase4-model-log-')), 'args.json')
    dirs.push(resolve(log, '..'))
    const result = await runPhase4Model(programme(), fixture, {
      env: stubEnvironment('success', log),
      deadlineMs: 1_000,
    })
    const transport = JSON.parse(readFileSync(log, 'utf8')) as { args: string[]; config: string }
    const config = transport.args[transport.args.indexOf('--config') + 1]
    const input = transport.args.find((arg) => arg.startsWith('@'))?.slice(1)

    expect(result.provenance.runtime).toMatchObject({ provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'low' })
    expect(result.provenance.limits).toEqual({ externalDeadlineMs: 1_000, nativeMaxTime: '1s' })
    expect(transport.args).toContain('--no-tools')
    expect(transport.args).toContain('--no-lsp')
    expect(transport.args[transport.args.indexOf('--cwd') + 1]).toBe(resolve(config, '..'))
    expect(transport.config).toContain('modelFallback: false')
    if (typeof input !== 'string') throw new Error('native runner did not pass an owned input attachment')
    expect(existsSync(config)).toBe(false)
    expect(existsSync(input)).toBe(false)
  })

  it('returns a complete stream after leader exit reaps a descendant retaining inherited stdout', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'phase4-model-exit-')), 'child.json')
    dirs.push(resolve(log, '..'))
    const result = await runPhase4Model(programme(), fixture, {
      env: stubEnvironment('leaky-success', log),
      deadlineMs: 1_000,
    })
    expect(result.body).toContain('Request changes')
    const descendant = JSON.parse(readFileSync(log, 'utf8')) as { child: number }
    const stat = `/proc/${descendant.child}/stat`
    expect(!existsSync(stat) || readFileSync(stat, 'utf8').split(') ')[1]?.startsWith('Z')).toBe(true)
  })

  it('fails visibly for a native error, partial stream, or changed model identity', async () => {
    await expect(
      runPhase4Model(programme(), fixture, { env: stubEnvironment('error'), deadlineMs: 1_000 }),
    ).rejects.toThrow('invocation failed')
    await expect(
      runPhase4Model(programme(), fixture, { env: stubEnvironment('partial'), deadlineMs: 1_000 }),
    ).rejects.toThrow('complete user turn')
    await expect(
      runPhase4Model(programme(), fixture, { env: stubEnvironment('wrong-model'), deadlineMs: 1_000 }),
    ).rejects.toThrow('unexpected provider, model, or stop reason')
  })

  it('accepts compatible terminal omissions and rejects continuing, pending, or nonterminal agent ends', async () => {
    await expect(
      runPhase4Model(programme(), fixture, { env: stubEnvironment('terminal-compatible'), deadlineMs: 1_000 }),
    ).resolves.toMatchObject({ body: expect.stringContaining('Request changes') })
    await expect(
      runPhase4Model(programme(), fixture, { env: stubEnvironment('terminal-continue'), deadlineMs: 1_000 }),
    ).rejects.toThrow(/flags=isTerminal=absent,yielded=false.*stdoutSha256=/)
    await expect(
      runPhase4Model(programme(), fixture, { env: stubEnvironment('terminal-pending'), deadlineMs: 1_000 }),
    ).rejects.toThrow('awaitingAsyncWork=true')
    await expect(
      runPhase4Model(programme(), fixture, { env: stubEnvironment('terminal-nonterminal'), deadlineMs: 1_000 }),
    ).rejects.toThrow('isTerminal=false')
  })

  it('enforces the shortened deadline and reaps its owned process group', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'phase4-model-timeout-')), 'child.json')
    dirs.push(resolve(log, '..'))
    await expect(
      runPhase4Model(programme(), fixture, { env: stubEnvironment('hang', log), deadlineMs: 500 }),
    ).rejects.toThrow('invocation failed')
    const termination = JSON.parse(readFileSync(log, 'utf8')) as { child: number; terminated?: boolean }
    expect(termination.child).toBeTypeOf('number')
    expect(termination.terminated).toBe(true)
  })
})
