import { mock } from 'bun:test'
import * as fs from 'node:fs'
import { createInterface } from 'node:readline'
import type { Destination, LatchNamespace, ProcessLifetime } from '../engine/fix-recovery-schema.ts'
import type { DestinationAdmissionLease } from '../omp/review-runtime/destination-admission-lease.ts'
import { observeCurrentLinuxHost, observePriorLinuxProcess } from '../omp/review-runtime/linux-execution-lease.ts'

let netnsReadFailures = 0
if (process.argv[3] === 'missing-netns') {
  // Fault only the host observation; the real native FileLock remains in use.
  const snapshot = { ...fs }
  const readlink = fs.readlinkSync
  mock.module('node:fs', () => ({
    ...snapshot,
    readlinkSync: (...args: Parameters<typeof readlink>) => {
      if (args[0] === '/proc/self/ns/net') {
        netnsReadFailures++
        throw Object.assign(new Error('fixture: netns observation unavailable'), { code: 'EACCES' })
      }
      return Reflect.apply(readlink, fs, args)
    },
  }))
}
// Load the admission module after the optional per-process fs fault is installed.
const { acquireDestinationAdmissionLease, recheckDestinationAdmissionLease, releaseDestinationAdmissionLease } =
  await import('../omp/review-runtime/destination-admission-lease.ts')

// This destination is a low-level fixture identity, not native authorization.
const destination = JSON.parse(process.argv[2] ?? 'null') as Destination
const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
let lease: DestinationAdmissionLease | undefined
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`)
try {
  for await (const line of input) {
    const request = JSON.parse(line) as {
      command:
        | 'acquire'
        | 'recheck'
        | 'release'
        | 'observe'
        | 'qualify'
        | 'copy-handle'
        | 'abandon'
        | 'fault-count'
        | 'exit'
      process?: ProcessLifetime
      namespace?: LatchNamespace
    }
    if (request.command === 'exit') break
    if (request.command === 'fault-count') {
      send({ netnsReadFailures })
      continue
    }
    if (request.command === 'abandon') {
      if (!lease) throw new Error('fixture-lease-missing')
      // Deliberately exit without releasing the native admission mutex.
      const flushed = Promise.withResolvers<void>()
      process.stdout.write(`${JSON.stringify({ status: 'abandoning' })}\n`, () => flushed.resolve())
      await flushed.promise
      process.exit(0)
    }
    if (request.command === 'copy-handle') {
      if (!lease) throw new Error('fixture-lease-missing')
      const copy = { ...lease }
      send({
        recheck: await recheckDestinationAdmissionLease(copy),
        release: await releaseDestinationAdmissionLease(copy),
        original: await recheckDestinationAdmissionLease(lease),
      })
      continue
    }
    if (request.command === 'acquire') {
      const result = await acquireDestinationAdmissionLease({ destination })
      if (result.status === 'acquired') {
        lease = result.lease
        send({
          status: result.status,
          descriptor: result.lease.descriptor,
          environment: {
            cwd: process.cwd(),
            home: process.env.HOME,
            profile: process.env.OMP_PROFILE,
            runtime: process.env.XDG_RUNTIME_DIR,
          },
        })
      } else if (result.status === 'uncertain') {
        // Retain ownership for explicit fixture cleanup; never present this as acquired.
        lease = result.retained
        send({ status: result.status, diagnostics: result.diagnostics })
      } else
        send({
          ...result,
          environment: {
            cwd: process.cwd(),
            home: process.env.HOME,
            profile: process.env.OMP_PROFILE,
            runtime: process.env.XDG_RUNTIME_DIR,
          },
        })
    } else if (request.command === 'qualify') {
      send(await observeCurrentLinuxHost())
    } else if (request.command === 'observe') {
      if (!request.process || !request.namespace) throw new Error('fixture-process-observation-missing')
      send(await observePriorLinuxProcess({ process: request.process, namespace: request.namespace }))
    } else if (request.command === 'recheck') {
      if (!lease) throw new Error('fixture-lease-missing')
      send(await recheckDestinationAdmissionLease(lease))
    } else {
      if (!lease) throw new Error('fixture-lease-missing')
      const result = await releaseDestinationAdmissionLease(lease)
      if (result.status === 'released') lease = undefined
      send(result)
    }
  }
} finally {
  input.close()
  // Fixture cleanup only: release the live child's own retained handle, never another entry.
  if (lease) {
    const result = await releaseDestinationAdmissionLease(lease)
    if (result.status !== 'released') {
      process.stderr.write(`fixture-owned-release-refused:${JSON.stringify(result)}\n`)
      process.exitCode = 1
    }
  }
}
