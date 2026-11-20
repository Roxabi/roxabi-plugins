import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { base, dispose, openState, pull, saved } from './sim-transport-fixture.ts'

function client(): string {
  const path = process.env.OMP_TEST_GH_SIMULATOR_PATH
  if (!path) throw new Error('fixture-gh-simulator-missing')
  return path
}

function invoke(
  file: string,
  cwd: string,
  argv: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; executable?: string; timeout?: number } = {},
) {
  return spawnSync(options.executable ?? client(), argv, {
    cwd,
    env: { ...process.env, GH_SIM_STATE: file, ...options.env },
    input: options.input,
    maxBuffer: 12 * 1024 * 1024,
    timeout: options.timeout ?? 15_000,
  })
}

describe('gh simulator server client', () => {
  it('runs barrier comments outside the server so unrelated requests can complete', async () => {
    const held = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40)) } }))
    const other = openState(base({ owner: 'other', name: 'repo' }))
    const started = join(held.root, 'started')
    const release = join(held.root, 'release')
    const child = spawn(
      client(),
      ['api', '--method', 'POST', 'repos/acme/app/issues/10/comments', '-f', 'body=hold-comment'],
      {
        cwd: held.root,
        env: {
          ...process.env,
          GH_SIM_STATE: held.file,
          GH_SIM_COMMENT_BARRIER_MATCH: 'hold-comment',
          GH_SIM_COMMENT_BARRIER_STARTED: started,
          GH_SIM_COMMENT_BARRIER_RELEASE: release,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const exited = Promise.withResolvers<number | null>()
    child.once('error', exited.reject)
    child.once('close', exited.resolve)
    const entered = Promise.withResolvers<void>()
    const watcher = watch(held.root, () => {
      if (existsSync(started)) entered.resolve()
    })
    if (existsSync(started)) entered.resolve()
    const deadline = AbortSignal.timeout(10_000)
    deadline.addEventListener('abort', () => entered.reject(new Error('barrier did not start')), { once: true })
    try {
      await Promise.race([
        entered.promise,
        exited.promise.then(() => {
          throw new Error(`barrier exited: ${stderr}`)
        }),
      ])
      expect(existsSync(started), `barrier not entered: ${stderr}`).toBe(true)
      expect(child.exitCode).toBeNull()
      const normal = invoke(other.file, other.root, ['repo', 'view', '--jq', '.nameWithOwner'], {
        env: {
          GH_SIM_COMMENT_BARRIER_MATCH: undefined,
          GH_SIM_COMMENT_BARRIER_STARTED: undefined,
          GH_SIM_COMMENT_BARRIER_RELEASE: undefined,
        },
        timeout: 3_000,
      })
      expect(normal.error).toBeUndefined()
      expect(normal.status, normal.stderr.toString()).toBe(0)
      expect(normal.stdout.toString()).toBe('other/repo\n')
      expect(child.exitCode).toBeNull()
      writeFileSync(release, 'go\n')
      expect(await exited.promise, stderr).toBe(0)
      expect(saved(held.file).prs['10'].comments.map((comment) => comment.body)).toEqual(['hold-comment'])
    } finally {
      watcher.close()
      writeFileSync(release, 'go\n')
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await exited.promise.catch(() => undefined)
      dispose(held.root)
      dispose(other.root)
    }
  })

  it('preserves at least 4 MiB of Unicode stdout byte for byte', () => {
    const body = `${'é界🙂'.repeat(500_000)}end`
    const box = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40), { body }) } }))
    try {
      const result = invoke(box.file, box.root, ['pr', 'view', '10', '--json', 'body'])
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr?.toString()).toBe(0)
      const expected = Buffer.from(`${JSON.stringify({ body })}\n`)
      expect(expected.length).toBeGreaterThanOrEqual(4 * 1024 * 1024)
      expect(
        result.stdout.equals(expected),
        `stdout bytes: ${result.stdout.length}, expected: ${expected.length}`,
      ).toBe(true)
      expect(result.stderr).toEqual(Buffer.alloc(0))
    } finally {
      dispose(box.root)
    }
  })

  it('preserves Unicode stdout without a trailing newline', () => {
    const body = 'café 界 🙂 end'
    const box = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40), { body }) } }))
    const bin = join(box.root, 'bin')
    mkdirSync(bin)
    // Request join-output mode from real jq to exercise a newline-free response.
    writeFileSync(join(bin, 'jq'), '#!/bin/sh\nPATH="$ORIGINAL_PATH"\nexport PATH\nexec jq -j "$@"\n', { mode: 0o755 })
    try {
      const result = invoke(box.file, box.root, ['pr', 'view', '10', '--json', 'body', '--jq', '.body'], {
        env: { ORIGINAL_PATH: process.env.PATH, PATH: `${bin}:${process.env.PATH ?? ''}` },
      })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr?.toString()).toBe(0)
      expect(result.stdout).toEqual(Buffer.from(body))
      expect(result.stderr).toEqual(Buffer.alloc(0))
    } finally {
      dispose(box.root)
    }
  })

  it('writes stdout before stderr when streams are merged and preserves success and failure statuses', () => {
    const box = openState(base())
    try {
      const merged = spawnSync('sh', ['-c', 'exec "$1" repo view --jq "debug | .nameWithOwner" 2>&1', 'sh', client()], {
        cwd: box.root,
        env: { ...process.env, GH_SIM_STATE: box.file },
        encoding: 'utf8',
        timeout: 15_000,
      })
      expect(merged.error).toBeUndefined()
      expect(merged.status, merged.stdout).toBe(0)
      expect(merged.stdout).toMatch(/^acme\/app\n\["DEBUG:",/)
      const failure = invoke(box.file, box.root, ['pr', 'diff', '1'])
      expect(failure.error).toBeUndefined()
      expect(failure.status).toBe(1)
      expect(failure.stdout).toEqual(Buffer.alloc(0))
      expect(failure.stderr.toString()).toContain('pr diff 1')
    } finally {
      dispose(box.root)
    }
  })

  it('stages stdin for a body-file comment without changing its contents', () => {
    const box = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40)) } }))
    try {
      const body = 'first\n\nUnicode: café 🙂\nlast'
      const result = invoke(box.file, box.root, ['pr', 'comment', '10', '--body-file', '-'], { input: body })
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr.toString()).toBe(0)
      expect(saved(box.file).prs['10'].comments[0].body).toBe(body)
    } finally {
      dispose(box.root)
    }
  })

  it('resolves a relative body file against the physical cwd reached through a symlink', () => {
    const box = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40)) } }))
    const actual = join(box.root, 'actual')
    const link = join(box.root, 'link')
    mkdirSync(actual)
    symlinkSync(actual, link)
    writeFileSync(join(actual, 'note.md'), 'physical directory\n')
    writeFileSync(join(box.root, 'note.md'), 'wrong directory\n')
    try {
      const result = invoke(box.file, link, ['pr', 'edit', '10', '--body-file', 'note.md'])
      expect(result.error).toBeUndefined()
      expect(result.status, result.stderr.toString()).toBe(0)
      expect(saved(box.file).prs['10'].body).toBe('physical directory\n')
    } finally {
      dispose(box.root)
    }
  })

  it('uses each invocation’s own state and environment without leaking either to the next call', () => {
    const first = openState(base({ owner: 'first', name: 'one' }))
    const second = openState(base({ owner: 'second', name: 'two' }))
    try {
      const args = ['repo', 'view', '--jq', '.nameWithOwner']
      const a = invoke(first.file, first.root, args)
      const b = invoke(second.file, second.root, args)
      const missing = invoke(first.file, first.root, args, { env: { GH_SIM_STATE: undefined } })
      const again = invoke(first.file, first.root, args)
      for (const result of [a, b, again]) {
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr.toString()).toBe(0)
      }
      expect(a.stdout.toString()).toBe('first/one\n')
      expect(b.stdout.toString()).toBe('second/two\n')
      expect(missing.error).toBeUndefined()
      expect(missing.status).toBe(1)
      expect(missing.stderr.toString()).toContain('GH_SIM_STATE is unset')
      expect(again.stdout.toString()).toBe('first/one\n')
      expect(saved(first.file).calls).toEqual([args, args])
      expect(saved(second.file).calls).toEqual([args])
    } finally {
      dispose(first.root)
      dispose(second.root)
    }
  })

  it('rejects a client with the wrong authentication token without executing the command', () => {
    const box = openState(base())
    try {
      const script = readFileSync(client(), 'utf8')
      const token = script.match(/printf '%s\\0' '([0-9a-f]{64})'/)?.[1]
      expect(token).toBeDefined()
      if (!token) throw new Error('client token not found')
      const badClient = join(box.root, 'bad-gh')
      const wrong = `${token[0] === '0' ? '1' : '0'}${token.slice(1)}`
      writeFileSync(badClient, script.replace(token, wrong), { mode: 0o700 })
      const result = invoke(box.file, box.root, ['repo', 'view'], { executable: badClient })
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain('authentication failed')
      expect(saved(box.file).calls).toEqual([])
    } finally {
      dispose(box.root)
    }
  })

  it('fails quickly rather than entering the server on a nested simulator request', () => {
    const box = openState(base())
    try {
      const result = invoke(box.file, box.root, ['repo', 'view'], {
        env: { OMP_GH_SIM_SERVER_REQUEST: '1' },
        timeout: 2_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.status).not.toBe(0)
      expect(result.stderr.toString()).toContain('nested gh call')
      expect(saved(box.file).calls).toEqual([])
    } finally {
      dispose(box.root)
    }
  })
})
