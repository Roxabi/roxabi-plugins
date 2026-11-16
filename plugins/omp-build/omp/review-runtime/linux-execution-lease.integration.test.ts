import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { canonicalValueDigest } from '../../engine/canonical-value.ts'
import type { Destination } from '../../engine/fix-recovery-schema.ts'

const BUN = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const HELPER = path.resolve(import.meta.dirname, '../../testing/linux-execution-lease-process.ts')

it('serializes a destination across distinct processes and observes the prior lifetime after exit', async () => {
  if (process.platform !== 'linux' || process.geteuid === undefined)
    throw new Error('fixture requires Linux and an effective UID')
  const root = mkdtempSync(path.join(tmpdir(), 'omp-lease-test-'))
  const seed = path.join(root, 'seed')
  const cloneA = path.join(root, 'clone-a')
  const cloneB = path.join(root, 'clone-b')
  const gitHome = path.join(root, 'git-home')
  mkdirSync(gitHome)
  const gitEnv = { ...process.env }
  for (const key of Object.keys(gitEnv)) if (key.startsWith('GIT_')) delete gitEnv[key]
  Object.assign(gitEnv, { HOME: gitHome, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' })
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env: gitEnv,
      encoding: 'utf8',
    }).trim()
  const children: { end(): void; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }[] = []
  try {
    mkdirSync(seed)
    git(seed, 'init', '-q', '-b', 'main')
    git(
      seed,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fixture',
    )
    git(root, 'clone', '-q', seed, cloneA)
    git(root, 'clone', '-q', seed, cloneB)
    expect(git(cloneA, 'rev-parse', '--absolute-git-dir')).not.toBe(git(cloneB, 'rev-parse', '--absolute-git-dir'))

    const suffix = randomUUID()
    // Explicit fixture identity only: not an authenticated GitHub destination.
    const destination: Destination = {
      authority: 'github.com',
      publicationRepository: 'fixture/lease-test',
      destinationRef: `refs/heads/lease-${suffix}`,
    }
    const a = child(cloneA, 'a', root, destination)
    children.push(a)
    const b = child(cloneB, 'b', root, destination)
    children.push(b)

    const acquired = await a.ask({ command: 'acquire' })
    const digest = canonicalValueDigest([
      destination.authority,
      destination.publicationRepository,
      destination.destinationRef,
    ])
    expect(acquired, JSON.stringify(acquired)).toMatchObject({
      status: 'acquired',
      descriptor: {
        protocol: 'omp-build-destination-mutex/1',
        destinationDigest: digest,
        namespace: { kind: 'linux-abstract' },
      },
    })
    expect(acquired.environment).toEqual({
      cwd: cloneA,
      home: path.join(root, 'home-a'),
      profile: 'profile-a',
      runtime: path.join(root, 'xdg-a'),
    })
    const qualified = await a.ask({ command: 'qualify' })
    expect(qualified, JSON.stringify(qualified)).toMatchObject({ status: 'qualified' })
    expect(qualified.process.pid).toBe(a.pid)
    expect(qualified.namespace.canonicalHostRoot).toBe(`/run/user/${process.geteuid()}`)
    expect(acquired.descriptor.namespace.networkNamespace).toBe(qualified.namespace.networkNamespace)
    const runtime = lstatSync(`/run/user/${process.geteuid()}`, { bigint: true })
    const latch = lstatSync(`/run/user/${process.geteuid()}/omp-build-execution/v1`, { bigint: true })
    expect(qualified.namespace).toMatchObject({
      rootDevice: String(runtime.dev),
      rootInode: String(runtime.ino),
      latchRootDevice: String(latch.dev),
      latchRootInode: String(latch.ino),
    })
    expect(await a.ask({ command: 'recheck' })).toMatchObject({ status: 'held', descriptor: acquired.descriptor })

    const occupied = await b.ask({ command: 'acquire' })
    expect(occupied).toMatchObject({
      status: 'occupied',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'lease-occupied' })]),
    })
    expect(occupied.environment).toEqual({
      cwd: cloneB,
      home: path.join(root, 'home-b'),
      profile: 'profile-b',
      runtime: path.join(root, 'xdg-b'),
    })
    const prior = { process: qualified.process, namespace: qualified.namespace }
    expect(await b.ask({ command: 'observe', ...prior })).toMatchObject({ state: 'alive', observed: qualified.process })

    expect(await a.ask({ command: 'release' })).toEqual({ status: 'released' })
    a.end()
    expect(await a.exited).toEqual({ code: 0, signal: null })
    const ended = await b.ask({ command: 'observe', ...prior })
    expect(ended.state, JSON.stringify(ended)).toBe('positively-ended')
    expect(['absent-in-validated-procfs', 'pid-reused']).toContain(ended.basis)
    const next = await b.ask({ command: 'acquire' })
    expect(next, JSON.stringify(next)).toMatchObject({ status: 'acquired', descriptor: acquired.descriptor })
    const nextQualified = await b.ask({ command: 'qualify' })
    expect(nextQualified).toMatchObject({ status: 'qualified', process: { pid: b.pid }, namespace: prior.namespace })
    expect(await b.ask({ command: 'recheck' })).toMatchObject({ status: 'held', descriptor: next.descriptor })
    expect(await b.ask({ command: 'release' })).toEqual({ status: 'released' })
    b.end()
    expect(await b.exited).toEqual({ code: 0, signal: null })
  } finally {
    for (const process of children) process.end()
    await Promise.all(children.map((process) => process.exited))
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps native destination contention when one process cannot observe its network namespace', async () => {
  if (process.platform !== 'linux') throw new Error('fixture requires Linux')
  const root = mkdtempSync(path.join(tmpdir(), 'omp-lease-no-netns-'))
  const destination: Destination = {
    authority: 'github.com',
    publicationRepository: 'fixture/lease-test',
    destinationRef: `refs/heads/no-netns-${randomUUID()}`,
  }
  const children: { end(): void; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }[] = []
  try {
    const unobservable = child(root, 'unobservable', root, destination, 'missing-netns')
    children.push(unobservable)
    const observable = child(root, 'observable', root, destination)
    children.push(observable)
    const acquired = await unobservable.ask({ command: 'acquire' })
    expect(acquired, JSON.stringify(acquired)).toMatchObject({
      status: 'acquired',
      descriptor: { namespace: { kind: 'linux-abstract', networkNamespace: null } },
    })
    expect((await unobservable.ask({ command: 'fault-count' })).netnsReadFailures).toBeGreaterThan(0)
    expect(await unobservable.ask({ command: 'recheck' })).toMatchObject({
      status: 'held',
      descriptor: acquired.descriptor,
    })
    expect(await observable.ask({ command: 'acquire' })).toMatchObject({
      status: 'occupied',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'lease-occupied' })]),
    })
    expect(await unobservable.ask({ command: 'release' })).toEqual({ status: 'released' })

    const normal = await observable.ask({ command: 'acquire' })
    expect(normal, JSON.stringify(normal)).toMatchObject({
      status: 'acquired',
      descriptor: { namespace: { kind: 'linux-abstract', networkNamespace: expect.any(String) } },
    })
    expect(normal.descriptor.destinationDigest).toBe(acquired.descriptor.destinationDigest)
    expect(await unobservable.ask({ command: 'acquire' })).toMatchObject({
      status: 'occupied',
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'lease-occupied' })]),
    })
    expect(await observable.ask({ command: 'release' })).toEqual({ status: 'released' })
    expect(await unobservable.ask({ command: 'acquire' })).toMatchObject({
      status: 'acquired',
      descriptor: acquired.descriptor,
    })
    expect(await unobservable.ask({ command: 'release' })).toEqual({ status: 'released' })
  } finally {
    for (const process of children) process.end()
    await Promise.all(children.map((process) => process.exited))
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['process-exit', 'copied-handle', 'namespace-mismatch'] as const)(
  'preserves native admission and observation boundaries: %s',
  async (scenario) => {
    if (process.platform !== 'linux' || process.geteuid === undefined)
      throw new Error('fixture requires Linux and an effective UID')
    const root = mkdtempSync(path.join(tmpdir(), 'omp-lease-boundary-'))
    const suffix = randomUUID()
    const destination: Destination = {
      authority: 'github.com',
      publicationRepository: 'fixture/lease-test',
      destinationRef: `refs/heads/boundary-${suffix}`,
    }
    const children: { end(): void; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }[] = []
    try {
      const a = child(root, 'a', root, destination)
      children.push(a)
      const b = child(root, 'b', root, destination)
      children.push(b)
      const acquired = await a.ask({ command: 'acquire' })
      expect(acquired, JSON.stringify(acquired)).toMatchObject({
        status: 'acquired',
        descriptor: { namespace: { kind: 'linux-abstract' } },
      })
      const refused = (code: string) => ({
        status: 'refused',
        diagnostics: expect.arrayContaining([expect.objectContaining({ code })]),
      })

      if (scenario === 'process-exit') {
        const qualified = await a.ask({ command: 'qualify' })
        expect(qualified, JSON.stringify(qualified)).toMatchObject({ status: 'qualified', process: { pid: a.pid } })
        const prior = { process: qualified.process, namespace: qualified.namespace }
        expect(await b.ask({ command: 'observe', ...prior })).toMatchObject({ state: 'alive', observed: prior.process })
        expect(await b.ask({ command: 'acquire' })).toMatchObject({
          status: 'occupied',
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'lease-occupied' })]),
        })
        expect(await a.ask({ command: 'abandon' })).toEqual({ status: 'abandoning' })
        expect(await a.exited).toEqual({ code: 0, signal: null })
        expect(await b.ask({ command: 'observe', ...prior })).toMatchObject({ state: 'positively-ended' })
        // Process exit releases the native mutex only; this says nothing about durable owner resolution.
        expect(await b.ask({ command: 'acquire' })).toMatchObject({
          status: 'acquired',
          descriptor: acquired.descriptor,
        })
        expect(await b.ask({ command: 'recheck' })).toMatchObject({ status: 'held', descriptor: acquired.descriptor })
        expect(await b.ask({ command: 'release' })).toEqual({ status: 'released' })
      } else if (scenario === 'copied-handle') {
        expect(await a.ask({ command: 'copy-handle' })).toMatchObject({
          recheck: refused('lease-handle-invalid'),
          release: refused('lease-handle-invalid'),
          original: { status: 'held', descriptor: acquired.descriptor },
        })
        expect(await b.ask({ command: 'acquire' })).toMatchObject({
          status: 'occupied',
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'lease-occupied' })]),
        })
        expect(await a.ask({ command: 'release' })).toEqual({ status: 'released' })
      } else {
        const qualified = await a.ask({ command: 'qualify' })
        expect(qualified, JSON.stringify(qualified)).toMatchObject({ status: 'qualified' })
        const incompatible = {
          ...qualified.namespace,
          mountNamespace: `${qualified.namespace.mountNamespace}-different`,
        }
        expect(await b.ask({ command: 'observe', process: qualified.process, namespace: incompatible })).toMatchObject({
          state: 'unknown',
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'namespace-mismatch' })]),
        })
        expect(await a.ask({ command: 'recheck' })).toMatchObject({ status: 'held', descriptor: acquired.descriptor })
        expect(await a.ask({ command: 'release' })).toEqual({ status: 'released' })
      }
    } finally {
      for (const process of children) process.end()
      await Promise.all(children.map((process) => process.exited))
      rmSync(root, { recursive: true, force: true })
    }
  },
)

function child(cwd: string, name: string, root: string, destination: Destination, fault?: 'missing-netns') {
  const home = path.join(root, `home-${name}`)
  const runtime = path.join(root, `xdg-${name}`)
  mkdirSync(home)
  mkdirSync(runtime)
  const process = spawn(BUN, [HELPER, JSON.stringify(destination), ...(fault ? [fault] : [])], {
    cwd,
    env: { ...globalThis.process.env, HOME: home, OMP_PROFILE: `profile-${name}`, XDG_RUNTIME_DIR: runtime },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 40_000,
    killSignal: 'SIGTERM',
  })
  let stderr = ''
  const transportErrors: string[] = []
  process.stdin.on('error', (error) => {
    transportErrors.push(error.message)
  })
  process.on('error', (error) => {
    transportErrors.push(error.message)
  })
  process.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  const lines = createInterface({ input: process.stdout })[Symbol.asyncIterator]()
  const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
  // close follows process exit/reap and stdio closure, including failed spawn.
  process.once('close', (code, signal) => exited.resolve({ code, signal }))
  return {
    pid: process.pid,
    exited: exited.promise,
    async ask(request: object) {
      try {
        process.stdin.write(`${JSON.stringify(request)}\n`)
      } catch (error) {
        transportErrors.push(error instanceof Error ? error.message : String(error))
      }
      const response = await lines.next()
      if (response.done)
        throw new Error(
          `fixture child ${name} exited without response: ${stderr}; stdin: ${transportErrors.join('; ')}`,
        )
      return JSON.parse(response.value)
    },
    end() {
      try {
        if (!process.stdin.destroyed && !process.stdin.writableEnded)
          process.stdin.end(`${JSON.stringify({ command: 'exit' })}\n`)
      } catch (error) {
        transportErrors.push(error instanceof Error ? error.message : String(error))
      }
    },
  }
}
