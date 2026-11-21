import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { afterAll, inject } from 'vitest'
import { simClientScript } from './plugins/omp-build/skills/feature/testing/gh-simulator/sim-client-script.ts'

const dir = mkdtempSync(path.join(path.resolve(tmpdir()), 'omp-test-gh-file-'))
const token = randomBytes(32).toString('hex')
const server = spawn(inject('ompTestGhServerPath'), [token, dir], { stdio: ['pipe', 'pipe', 'inherit'] })
const { promise, resolve, reject } = Promise.withResolvers<string>()
const lines = createInterface({ input: server.stdout })
lines.once('line', (line) => {
  lines.close()
  if (!/^\d+$/.test(line)) reject(new Error(`gh simulator: invalid port ${line}`))
  else resolve(line)
})
server.once('error', reject)
server.once('exit', (code) => reject(new Error(`gh simulator: server exited (${code})`)))

async function stopServer(): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return
  const { promise, resolve } = Promise.withResolvers<void>()
  server.once('exit', () => resolve())
  if (!server.kill()) resolve()
  await promise
}

try {
  const port = Number(await promise)
  const fallbacks = {
    sim: inject('ompTestGhStandalonePath'),
    fault: path.resolve(import.meta.dirname, 'plugins/omp-build/testing/fix-recovery-gh-fault.ts'),
  }
  for (const mode of ['sim', 'fault'] as const) {
    const client = path.join(dir, mode === 'sim' ? 'gh' : 'gh-fault')
    writeFileSync(client, simClientScript({ mode, port, token, dir, fallback: fallbacks[mode] }), { mode: 0o700 })
    if (mode === 'sim') process.env.OMP_TEST_GH_SIMULATOR_PATH = client
    else process.env.OMP_TEST_GH_FAULT_CLIENT_PATH = client
  }
  // Fixtures and their child processes can use these without depending on Vitest.
  process.env.OMP_TEST_PIN_GH_PATH = inject('ompTestPinGhPath')
  process.env.OMP_TEST_TOOLING_GH_PATH = inject('ompTestToolingGhPath')
} catch (error) {
  await stopServer()
  rmSync(dir, { recursive: true, force: true })
  throw error
}

afterAll(async () => {
  await stopServer()
  rmSync(dir, { recursive: true, force: true })
})
