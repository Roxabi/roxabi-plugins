import { type ChildProcess, execFileSync, type SpawnSyncReturns, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { base, dispose, openState, pull, saved } from '../skills/feature/testing/gh-simulator/sim-transport-fixture.ts'

function executable(name: 'OMP_TEST_PIN_GH_CLIENT_PATH' | 'OMP_TEST_PIN_GH_PATH'): string {
  const path = process.env[name]
  if (!path) throw new Error(`${name} missing`)
  return path
}

const source = 'Roxabi/roxabi-plugins'
const variable = (repo: string) => ['variable', 'get', 'OMP_BUILD_TOOLING_SHA', '--repo', repo]
const candidate = 'a'.repeat(40)
const shared = 'b'.repeat(40)

function environment(file: string) {
  return {
    ...process.env,
    GH_SIM_STATE: file,
    PIN_CANDIDATE: candidate,
    PIN_DEFAULT_HEAD: 'c'.repeat(40),
    PIN_SHARED: shared,
  }
}

function invoke(path: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) {
  return spawnSync(path, args, { cwd, env, input, encoding: 'utf8', timeout: 10_000 })
}

function outcome(result: SpawnSyncReturns<string>) {
  expect(result.error).toBeUndefined()
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

type Exit = { code: number | null; signal: NodeJS.Signals | null }

function exited(child: ChildProcess) {
  const { promise, resolve, reject } = Promise.withResolvers<Exit>()
  child.once('error', reject)
  child.once('close', (code, signal) => resolve({ code, signal }))
  return promise
}

async function waitForReady(dir: string, exit: Promise<Exit>) {
  const marker = join(dir, 'ready')
  const ready = Promise.withResolvers<void>()
  const watcher = watch(dir, () => {
    if (existsSync(marker)) ready.resolve()
  })
  if (existsSync(marker)) ready.resolve()
  // An external process may fail to publish; fake timers cannot bound that failure.
  const timeout = setTimeout(() => ready.reject(new Error('pin gate did not become ready')), 10_000)
  try {
    await Promise.race([
      ready.promise,
      exit.then((result) => {
        throw new Error(`pin command exited early: ${JSON.stringify(result)}`)
      }),
    ])
  } finally {
    clearTimeout(timeout)
    watcher.close()
  }
}

describe('pin gh server protocol', () => {
  it('uses each caller environment and cwd and reloads the control file', () => {
    const state = openState(base())
    try {
      const first = join(state.root, 'first')
      const second = join(state.root, 'second')
      mkdirSync(first)
      mkdirSync(second)
      writeFileSync(join(first, 'control.json'), JSON.stringify({ shared: 'first-control' }))
      writeFileSync(join(second, 'control.json'), JSON.stringify({ shared: 'second-control' }))
      const client = executable('OMP_TEST_PIN_GH_CLIENT_PATH')
      const env = { ...environment(state.file), PIN_CONTROL_FILE: 'control.json' }
      expect(outcome(invoke(client, variable(source), first, env))).toEqual({
        status: 0,
        stdout: 'first-control\n',
        stderr: '',
      })
      expect(outcome(invoke(client, variable(source), second, env))).toEqual({
        status: 0,
        stdout: 'second-control\n',
        stderr: '',
      })
      writeFileSync(join(first, 'control.json'), JSON.stringify({ shared: 'updated-control' }))
      expect(outcome(invoke(client, variable(source), first, env))).toEqual({
        status: 0,
        stdout: 'updated-control\n',
        stderr: '',
      })
      expect(
        outcome(invoke(client, variable('acme/app'), first, { ...env, PIN_CANDIDATE: 'caller-candidate' })),
      ).toEqual({ status: 0, stdout: 'caller-candidate\n', stderr: '' })
    } finally {
      dispose(state.root)
    }
  })

  for (const mode of ['gate', 'sync'] as const) {
    it(`keeps the server responsive while the ${mode} command waits standalone`, async () => {
      const state = openState(base())
      const other = openState(base())
      const dir = join(state.root, mode)
      mkdirSync(dir)
      execFileSync('mkfifo', [join(dir, 'release')])
      const client = executable('OMP_TEST_PIN_GH_CLIENT_PATH')
      const env = {
        ...environment(state.file),
        ...(mode === 'gate' ? { PIN_FEATURE_GATE: dir } : { PIN_SYNC_DIR: dir }),
      }
      const args =
        mode === 'gate'
          ? variable(source)
          : ['api', 'graphql', '-f', `expression=${candidate}:plugins/omp-build/package.json`]
      if (mode === 'sync') {
        const first = invoke(client, args, state.root, env)
        expect(outcome(first).status, first.stderr).toBe(0)
      }
      const child = spawn(client, args, { cwd: state.root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      child.stdout.resume()
      const exit = exited(child)
      let releaser: ChildProcess | undefined
      try {
        await waitForReady(dir, exit)
        expect(child.exitCode).toBeNull()
        // No gate or sync variable: this call goes through the server, so it hangs if the waiting call holds it.
        expect(outcome(invoke(client, variable('acme/app'), other.root, environment(other.file)))).toEqual({
          status: 0,
          stdout: `${candidate}\n`,
          stderr: '',
        })
        expect(child.exitCode).toBeNull()
        releaser = spawn('sh', ['-c', 'printf release > "$1"', 'release', join(dir, 'release')], { stdio: 'ignore' })
        expect(await exit, stderr).toEqual({ code: 0, signal: null })
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill()
        await exit.catch(() => undefined)
        releaser?.kill()
        dispose(state.root)
        dispose(other.root)
      }
    })
  }

  it('matches the compiled fixture for simulator fallthrough including stdin and errors', () => {
    const prs = { 10: pull(10, 'feat/a', 'a'.repeat(40)) }
    const direct = openState(base({ prs }))
    const served = openState(base({ prs }))
    try {
      const binary = executable('OMP_TEST_PIN_GH_PATH')
      const client = executable('OMP_TEST_PIN_GH_CLIENT_PATH')
      const body = 'staged body\n\nUnicode: café 🙂\nlast'
      const commands: Array<{ args: string[]; input?: string }> = [
        { args: ['pr', 'comment', '10', '--body-file', '-'], input: body },
        { args: ['api', 'unsupported/endpoint'] },
      ]
      for (const { args, input } of commands) {
        const expected = invoke(binary, args, direct.root, environment(direct.file), input)
        const actual = invoke(client, args, served.root, environment(served.file), input)
        expect(outcome(actual)).toEqual(outcome(expected))
      }
      expect(saved(served.file).prs['10'].comments[0].body).toBe(body)
      expect(JSON.parse(readFileSync(served.file, 'utf8'))).toEqual(JSON.parse(readFileSync(direct.file, 'utf8')))
    } finally {
      dispose(direct.root)
      dispose(served.root)
    }
  })
})
