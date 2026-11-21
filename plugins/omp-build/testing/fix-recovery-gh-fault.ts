#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { executeFaultCommand } from './fix-recovery-gh-fault-core.ts'

const result = executeFaultCommand(process.argv.slice(2), {
  cwd: process.cwd(),
  readStdin: () => readFileSync(0, 'utf8'),
})
if (result.awaitRelease) {
  const deadline = result.awaitDeadline ?? Date.now() + 30_000
  const signal = new Int32Array(new SharedArrayBuffer(4))
  while (!existsSync(result.awaitRelease) && Date.now() < deadline) Atomics.wait(signal, 0, 0, 25)
  if (!existsSync(result.awaitRelease)) throw new Error('fixture: publication gate timed out')
}
process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exitCode = result.status
