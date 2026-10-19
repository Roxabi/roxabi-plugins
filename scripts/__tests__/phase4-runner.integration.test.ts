import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Phase4Fixture, readPhase4Programme, runPhase4Model } from '../phase4-model'

const dirs: string[] = []
const fixture: Phase4Fixture = { id: 'transport-fixture', snapshot: 'synthetic reports' }

function stubEnvironment(mode: string, log?: string): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), 'phase4-model-bin-'))
  dirs.push(bin)
  const executable = join(bin, 'omp')
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const args = process.argv.slice(2)
const log = (entry) => {
  if (process.env.PHASE4_STUB_LOG) appendFileSync(process.env.PHASE4_STUB_LOG, JSON.stringify(entry) + '\\n')
}
log({ args })
if (args[0] === '--version') process.stdout.write('omp/18.12.2\\n')
else {
  if (process.env.PHASE4_STUB_MODE === 'error') process.exitCode = 2
  else if (process.env.PHASE4_STUB_MODE === 'partial') process.stdout.write(JSON.stringify({ type: 'session' }) + '\\n')
  else if (process.env.PHASE4_STUB_MODE === 'hang') {
    const child = spawn(process.execPath, ['-e', "const { appendFileSync } = require('node:fs')\\nprocess.on('SIGTERM', () => { appendFileSync(process.env.PHASE4_STUB_LOG, JSON.stringify({ child: process.pid, terminated: true }) + '\\\\n')\\nprocess.exit(0) })\\nrequire('node:fs').writeFileSync(process.env.PHASE4_STUB_READY, '')\\nsetInterval(() => {}, 1_000)"], { stdio: 'ignore' })
    while (!existsSync(process.env.PHASE4_STUB_READY)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
    log({ child: child.pid })
  } else {
    const attachment = args.find((arg) => arg.startsWith('@'))
    const input = readFileSync(attachment.slice(1), 'utf8')
    let child
    if (process.env.PHASE4_STUB_MODE === 'leaky-success') {
      child = spawn(process.execPath, ['-e', "const { writeFileSync } = require('node:fs')\\nprocess.on('SIGTERM', () => {})\\nwriteFileSync(process.env.PHASE4_STUB_READY, '')\\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)"], { stdio: ['ignore', 'inherit', 'ignore'] })
      while (!existsSync(process.env.PHASE4_STUB_READY)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
      child.unref()
    }
    log({ temporary: { config: args[args.indexOf('--config') + 1], input: attachment.slice(1) }, child: child?.pid })
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
    ROXABI_PHASE4_MODEL: '1',
    PHASE4_STUB_MODE: mode,
    PHASE4_STUB_LOG: log,
    PHASE4_STUB_READY: mode === 'leaky-success' || mode === 'hang' ? join(bin, 'ready') : undefined,
  }
}

function readStubLog(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('runPhase4Model native transport', () => {
  it('requires explicit opt-in before resolving or invoking the native executable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'phase4-model-no-opt-in-'))
    dirs.push(directory)
    const log = join(directory, 'calls.jsonl')
    const environment = stubEnvironment('success', log)
    environment.ROXABI_PHASE4_MODEL = undefined

    await expect(
      runPhase4Model(readPhase4Programme(), fixture, { env: environment, deadlineMs: 1_000 }),
    ).rejects.toThrow('requires explicit ROXABI_PHASE4_MODEL=1 opt-in')
    expect(readStubLog(log)).toEqual([])
  })

  it('does not attest caller-mutated source text as the committed programme', async () => {
    const programme = readPhase4Programme()
    const original = await runPhase4Model(programme, fixture, { env: stubEnvironment('success'), deadlineMs: 1_000 })
    expect(original.provenance.programme.every((source) => source.atCommit)).toBe(true)
    const source = programme.sources[0]
    const committedSHA = source.sourceSHA
    source.text += '\\nAltered source for the provenance regression.\\n'
    source.sourceSHA = createHash('sha256').update(source.text).digest('hex')
    const altered = await runPhase4Model(programme, fixture, { env: stubEnvironment('success'), deadlineMs: 1_000 })
    expect(altered.provenance.programme[0]).toMatchObject({ sourceSHA: committedSHA, atCommit: false })
    expect(altered.provenance.programme[0].sentSHA).not.toBe(committedSHA)
  })

  it('never attests fabricated blob or candidate identities', async () => {
    const programme = readPhase4Programme()
    programme.sources[0].gitBlob = '0'.repeat(40)
    const forged = await runPhase4Model(programme, fixture, { env: stubEnvironment('success'), deadlineMs: 1_000 })
    expect(forged.provenance.programme[0].atCommit).toBe(false)

    programme.commitSHA = '0'.repeat(40)
    await expect(
      runPhase4Model(programme, fixture, { env: stubEnvironment('success'), deadlineMs: 1_000 }),
    ).rejects.toThrow('programme git probe failed')
  })

  it('refuses non-POSIX hosts before starting native work', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'phase4-model-platform-')), 'started.jsonl')
    dirs.push(resolve(log, '..'))
    const env = stubEnvironment('success', log)
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platform) throw new Error('Node platform descriptor is unavailable')
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      await expect(runPhase4Model(readPhase4Programme(), fixture, { env, deadlineMs: 1_000 })).rejects.toThrow(
        'requires POSIX process-group cleanup',
      )
      expect(readStubLog(log)).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('records stream-validated runtime provenance and removes owned inputs after a complete native stream', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'phase4-model-log-')), 'calls.jsonl')
    dirs.push(resolve(log, '..'))
    const result = await runPhase4Model(readPhase4Programme(), fixture, {
      env: stubEnvironment('success', log),
      deadlineMs: 1_000,
    })
    const calls = readStubLog(log)
    const native = calls.find((call) => 'temporary' in call)
    if (!native || typeof native.temporary !== 'object' || native.temporary === null) {
      throw new Error('native runner did not create an owned temporary input')
    }
    const temporary = native.temporary as { config: string; input: string }

    expect(calls.map((call) => call.args)).toContainEqual(['--version'])
    expect(result.provenance.runtime).toMatchObject({
      provider: 'openai-codex',
      model: 'gpt-6.1-sol',
      requestedThinking: 'low',
    })
    expect(result.provenance.limits).toEqual({ externalDeadlineMs: 1_000, nativeMaxTime: '1s' })
    expect(existsSync(temporary.config)).toBe(false)
    expect(existsSync(temporary.input)).toBe(false)
  })

  it('returns a complete stream after leader exit reaps a descendant retaining inherited stdout', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'phase4-model-exit-')), 'child.jsonl')
    dirs.push(resolve(log, '..'))
    await runPhase4Model(readPhase4Programme(), fixture, {
      env: stubEnvironment('leaky-success', log),
      deadlineMs: 1_000,
    })
    const descendant = readStubLog(log).find((entry) => typeof entry.child === 'number')
    if (!descendant || typeof descendant.child !== 'number') throw new Error('stub did not record descendant')
    const stat = `/proc/${descendant.child}/stat`
    expect(!existsSync(stat) || readFileSync(stat, 'utf8').split(') ')[1]?.startsWith('Z')).toBe(true)
  })

  it('fails visibly for a native error, partial stream, or changed model identity', async () => {
    await expect(
      runPhase4Model(readPhase4Programme(), fixture, { env: stubEnvironment('error'), deadlineMs: 1_000 }),
    ).rejects.toThrow('invocation failed')
    await expect(
      runPhase4Model(readPhase4Programme(), fixture, { env: stubEnvironment('partial'), deadlineMs: 1_000 }),
    ).rejects.toThrow('complete user turn')
    await expect(
      runPhase4Model(readPhase4Programme(), fixture, { env: stubEnvironment('wrong-model'), deadlineMs: 1_000 }),
    ).rejects.toThrow('unexpected provider, model, or stop reason')
  })

  it('accepts compatible terminal omissions and rejects continuing, pending, or nonterminal agent ends', async () => {
    await expect(
      runPhase4Model(readPhase4Programme(), fixture, {
        env: stubEnvironment('terminal-compatible'),
        deadlineMs: 1_000,
      }),
    ).resolves.toMatchObject({ body: expect.any(String) })
    await expect(
      runPhase4Model(readPhase4Programme(), fixture, { env: stubEnvironment('terminal-continue'), deadlineMs: 1_000 }),
    ).rejects.toThrow(/flags=isTerminal=absent,yielded=false.*stdoutSha256=/)
    await expect(
      runPhase4Model(readPhase4Programme(), fixture, { env: stubEnvironment('terminal-pending'), deadlineMs: 1_000 }),
    ).rejects.toThrow('awaitingAsyncWork=true')
    await expect(
      runPhase4Model(readPhase4Programme(), fixture, {
        env: stubEnvironment('terminal-nonterminal'),
        deadlineMs: 1_000,
      }),
    ).rejects.toThrow('isTerminal=false')
  })

  it('enforces the shortened deadline and reaps its owned process group', async () => {
    const log = join(mkdtempSync(join(tmpdir(), 'phase4-model-timeout-')), 'child.jsonl')
    dirs.push(resolve(log, '..'))
    await expect(
      runPhase4Model(readPhase4Programme(), fixture, { env: stubEnvironment('hang', log), deadlineMs: 500 }),
    ).rejects.toThrow('invocation failed')
    const termination = readStubLog(log).find((entry) => entry.terminated === true)
    expect(termination).toMatchObject({ child: expect.any(Number), terminated: true })
  })
})
