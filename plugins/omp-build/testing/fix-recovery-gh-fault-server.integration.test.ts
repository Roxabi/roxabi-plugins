import type { ChildProcess, SpawnSyncReturns } from 'node:child_process'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { base, dispose, openState, pull, saved } from '../skills/feature/testing/gh-simulator/sim-transport-fixture.ts'
import { isRecoveryFaultGh } from './fix-recovery-gh-identity.ts'

function client(): string {
  const path = process.env.OMP_TEST_GH_FAULT_CLIENT_PATH
  if (!path) throw new Error('fixture-gh-fault-client-missing')
  return path
}

const endpoint = 'repos/acme/app/issues/10/comments'
const body = '<!-- omp-build-record v=1 kind=fix-request id=test -->\nfirst'
const post = (text: string) => ['api', '--method', 'POST', endpoint, '-f', `body=${text}`]

function assertReconciliation(before: boolean, marker: string, invoke: (argv: string[]) => SpawnSyncReturns<string>) {
  const query = ['api', `${endpoint}?per_page=100&page=1`, '--include']
  const firstRead = invoke(query)
  expect(firstRead.error).toBeUndefined()
  if (before) {
    expect(firstRead.status, firstRead.stderr).toBe(0)
    expect(existsSync(`${marker}.read-failed`)).toBe(false)
  } else {
    expect(firstRead.status).toBe(1)
    expect(firstRead.stderr).toContain('fixture: one reconciliation GET failed')
    expect(JSON.parse(readFileSync(`${marker}.read-failed`, 'utf8'))).toEqual({
      endpoint: `${endpoint}?per_page=100&page=1`,
      operation: 'reconcile-page-one',
    })
    const secondRead = invoke(query)
    expect(secondRead.error).toBeUndefined()
    expect(secondRead.status, secondRead.stderr).toBe(0)
    expect(secondRead.stdout).toContain('second')
  }
}

function watchForMarker(root: string, marker: string, published: PromiseWithResolvers<void>) {
  const watcher = watch(root, () => {
    if (existsSync(marker)) published.resolve()
  })
  if (existsSync(marker)) published.resolve()
  return watcher
}

function killIfRunning(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) child.kill()
}

describe('gh fault server client', () => {
  for (const before of [true, false]) {
    it(`gates the first matching POST ${before ? 'before dispatch' : 'after persistence'} without blocking other calls`, async () => {
      const state = openState(base({ prs: { 10: pull(10, 'feat/a', 'a'.repeat(40)) } }))
      const marker = join(state.root, 'fault-marker')
      const release = join(state.root, 'fault-release')
      const env = {
        ...process.env,
        GH_SIM_STATE: state.file,
        FIX_RECOVERY_FAULT_KIND: 'fix-request',
        FIX_RECOVERY_FAULT_MARKER: marker,
        FIX_RECOVERY_FAULT_BEFORE: before ? '1' : '0',
        FIX_RECOVERY_FAULT_RELEASE: release,
        FIX_RECOVERY_FAIL_RECONCILE: '1',
      }
      const args = post(body)
      const child = spawn(client(), args, { cwd: state.root, env, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk
      })
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk
      })
      const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
      child.once('error', exited.reject)
      child.once('close', (code, signal) => exited.resolve({ code, signal }))
      const published = Promise.withResolvers<void>()
      const watcher = watchForMarker(state.root, marker, published)
      // A real deadline bounds failure if the external process never publishes its marker.
      const deadline = setTimeout(() => published.reject(new Error('fault marker not published')), 10_000)
      const invoke = (argv: string[]) =>
        spawnSync(client(), argv, { cwd: state.root, env, encoding: 'utf8', timeout: 10_000 })
      try {
        await Promise.race([
          published.promise,
          exited.promise.then((result) => {
            throw new Error(`fault child exited early: ${JSON.stringify(result)} ${stderr}`)
          }),
        ])
        expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ kind: 'fix-request', body, argv: args, before })
        expect(child.exitCode).toBeNull()
        expect(saved(state.file).prs['10'].comments.map((comment) => comment.body)).toEqual(before ? [] : [body])

        const secondBody = '<!-- omp-build-record v=1 kind=fix-request id=other -->\nsecond'
        const second = invoke(post(secondBody))
        expect(second.error).toBeUndefined()
        expect(second.status, second.stderr).toBe(0)
        expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({ kind: 'fix-request', body, argv: args, before })
        expect(child.exitCode).toBeNull()
        expect(stderr).toBe('')
        expect(stdout).toBe('')
        expect(saved(state.file).prs['10'].comments.map((comment) => comment.body)).toEqual(
          before ? [secondBody] : [body, secondBody],
        )

        writeFileSync(release, 'release\n')
        expect(await exited.promise, stderr).toEqual({ code: 1, signal: null })
        expect(stdout).toBe('')
        expect(stderr).toContain(
          before ? 'fixture: POST refused before simulator dispatch' : 'fixture: response lost after accepted comment',
        )

        assertReconciliation(before, marker, invoke)
      } finally {
        clearTimeout(deadline)
        watcher.close()
        writeFileSync(release, 'release\n')
        killIfRunning(child)
        await exited.promise.catch(() => undefined)
        dispose(state.root)
      }
    })
  }

  it('lets the recovery guards accept only the fault script or a generated fault client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'omp-fault-identity-'))
    const generated = client()
    const forge = (name: string, text: string) => {
      const file = join(dir, name)
      writeFileSync(file, text, { mode: 0o700 })
      return file
    }
    try {
      const linked = join(dir, 'gh')
      symlinkSync(generated, linked)
      expect(isRecoveryFaultGh(join(import.meta.dirname, 'fix-recovery-gh-fault.ts'))).toBe(true)
      expect(isRecoveryFaultGh(linked)).toBe(true)
      const simulator = process.env.OMP_TEST_GH_SIMULATOR_PATH
      if (!simulator) throw new Error('fixture-gh-simulator-missing')
      expect(isRecoveryFaultGh(simulator)).toBe(false)
      const text = readFileSync(generated, 'utf8')
      // A fault-mode client falling back to another fault script is someone else's.
      const foreign = forge('fix-recovery-gh-fault.ts', '')
      const foreignFallback = text.replace(/exec bun '[^']+' "\$@"/, `exec bun '${foreign}' "$@"`)
      expect(foreignFallback).toContain(foreign)
      expect(isRecoveryFaultGh(forge('foreign', foreignFallback))).toBe(false)
      // The client's own lines do not vouch for commands placed around them.
      expect(isRecoveryFaultGh(forge('early-exit', text.replace('#!/bin/bash\n', '#!/bin/bash\nexit 0\n')))).toBe(false)
      // Neither does the environment that names the client.
      const unrelated = forge('other', '#!/bin/bash\nexit 0\n')
      process.env.OMP_TEST_GH_FAULT_CLIENT_PATH = unrelated
      expect(isRecoveryFaultGh(unrelated)).toBe(false)
    } finally {
      process.env.OMP_TEST_GH_FAULT_CLIENT_PATH = generated
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
